#!/usr/bin/env python3
"""Restart Linux Codex through Hyprland from an independent systemd user unit."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import time

BINARY = Path('/usr/lib/chatgpt/ChatGPT')
STATE = Path.home() / '.local/state/codex-restart'
KEYS = ('DISPLAY', 'WAYLAND_DISPLAY', 'HYPRLAND_INSTANCE_SIGNATURE',
        'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_SESSION_TYPE', 'XAUTHORITY')


def app_pids():
    found = []
    for entry in Path('/proc').glob('[0-9]*'):
        try:
            args = (entry / 'cmdline').read_bytes().split(b'\0')
            if (entry / 'exe').resolve() == BINARY and not any(token.startswith(b'--type=') for arg in args for token in arg.split()):
                found.append(int(entry.name))
        except (OSError, RuntimeError):
            continue
    return found


def session_environment():
    env = os.environ.copy()
    pids = app_pids()
    if len(pids) > 1:
        raise RuntimeError('Multiple desktop main processes; inspect before restarting')
    # Read only graphical-session keys; never log or forward arbitrary app secrets.
    if pids:
        for item in Path(f'/proc/{pids[0]}/environ').read_bytes().split(b'\0'):
            key, sep, value = item.partition(b'=')
            if sep and key.decode() in KEYS:
                env[key.decode()] = value.decode()
    env.setdefault('XDG_RUNTIME_DIR', f'/run/user/{os.getuid()}')
    env.setdefault('DBUS_SESSION_BUS_ADDRESS', f"unix:path={env['XDG_RUNTIME_DIR']}/bus")
    if not env.get('HYPRLAND_INSTANCE_SIGNATURE'):
        result = subprocess.run(['hyprctl', 'instances', '-j'], env=env, check=True, capture_output=True, text=True)
        instances = json.loads(result.stdout)
        if len(instances) != 1:
            raise RuntimeError('Cannot identify one Hyprland session')
        env['HYPRLAND_INSTANCE_SIGNATURE'] = instances[0]['instance']
    return env


def windows(env):
    result = subprocess.run(['hyprctl', 'clients', '-j'], env=env, check=True, capture_output=True, text=True)
    pids = app_pids()
    return [w for w in json.loads(result.stdout) if w.get('pid') in pids and w.get('mapped')]


def dispatch(lua, env):
    result = subprocess.run(['hyprctl', 'dispatch', lua], env=env, check=True, capture_output=True, text=True)
    if result.stdout.strip() != 'ok':
        raise RuntimeError('Hyprland dispatch failed: ' + result.stdout.strip())


def status(**values):
    STATE.mkdir(parents=True, exist_ok=True)
    data = {'time': time.strftime('%FT%T%z'), **values}
    temp = STATE / 'status.tmp'
    temp.write_text(json.dumps(data, indent=2) + '\n')
    temp.replace(STATE / 'status.json')
    print(json.dumps(data), flush=True)


def restart(env):
    old = app_pids()
    current = windows(env)
    if old and not current:
        raise RuntimeError('Desktop has no mapped window; inspect before restarting')
    workspace = current[0]['workspace']['id'] if current else None
    status(state='stopping', old_pids=old)
    for pid in old:
        os.kill(pid, signal.SIGTERM)
    deadline = time.monotonic() + 45
    while app_pids() and time.monotonic() < deadline:
        time.sleep(0.5)
    if app_pids():
        raise RuntimeError('Codex did not exit gracefully; no force-kill was attempted')
    dispatch('hl.dsp.exec_cmd("/usr/bin/chatgpt")', env)
    status(state='launching', old_pids=old)
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        new = windows(env)
        if new and new[0]['pid'] not in old:
            window = new[0]
            if workspace is not None and workspace > 0 and window['workspace']['id'] != workspace:
                address = json.dumps('address:' + window['address'])
                dispatch(f'hl.dsp.window.move({{ window = {address}, workspace = {workspace}, silent = true }})', env)
            time.sleep(2)
            verified = windows(env)
            if not any(w['pid'] == window['pid'] for w in verified):
                raise RuntimeError('Desktop window disappeared after launch')
            status(state='verified', old_pids=old, new_pid=window['pid'], window=window['address'])
            return
        time.sleep(1)
    raise RuntimeError('No new mapped Codex window within 90 seconds')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--probe', action='store_true')
    mode.add_argument('--schedule', type=int, metavar='SECONDS')
    mode.add_argument('--run', action='store_true')
    args = parser.parse_args()
    env = session_environment()
    if args.probe:
        dispatch('hl.dsp.exec_cmd("true")', env)
        print(json.dumps({'pids': app_pids(), 'windows': [
            {'pid': w['pid'], 'workspace': w['workspace']['id']} for w in windows(env)]}))
    elif args.schedule is not None:
        if not 5 <= args.schedule <= 300:
            parser.error('Schedule delay must be between 5 and 300 seconds')
        dispatch('hl.dsp.exec_cmd("true")', env)
        if not windows(env):
            raise RuntimeError('No running mapped Codex window')
        command = ['systemd-run', '--user', '--collect', '--unit=codex-desktop-restart',
                   f'--on-active={args.schedule}s', '--timer-property=AccuracySec=1s',
                   '--property=Type=exec']
        command += [f'--setenv={key}={env[key]}' for key in KEYS if key in env]
        command += ['/usr/bin/python3', str(Path(__file__).resolve()), '--run']
        subprocess.run(command, env=env, check=True)
        status(state='scheduled', delay_seconds=args.schedule)
    else:
        try:
            restart(env)
        except Exception as exc:
            status(state='failed', error=str(exc))
            raise


if __name__ == '__main__':
    main()
