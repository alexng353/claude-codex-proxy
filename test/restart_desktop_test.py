"""The restart must fail honestly and must never escalate to a force-kill."""
import importlib.util
from pathlib import Path
import signal
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'restart', Path(__file__).parents[1] / 'skills/restart-codex-desktop/scripts/restart.py')
restart = importlib.util.module_from_spec(spec)
spec.loader.exec_module(restart)

OLD = {'pid': 100, 'workspace': {'id': 3}, 'address': '0x1'}
NEW = {'pid': 200, 'workspace': {'id': 3}, 'address': '0x2'}


class RestartTests(unittest.TestCase):
    def test_success_requires_a_new_mapped_window(self):
        with patch.object(restart, 'app_pids', side_effect=[[100], [], []]), \
             patch.object(restart, 'windows', side_effect=[[OLD], [NEW], [NEW]]), \
             patch.object(restart.os, 'kill') as kill, \
             patch.object(restart, 'dispatch') as dispatch, \
             patch.object(restart.time, 'sleep'), \
             patch.object(restart, 'status') as status:
            restart.restart({})
            kill.assert_called_once_with(100, signal.SIGTERM)
            dispatch.assert_called_once_with('hl.dsp.exec_cmd("/usr/bin/chatgpt")', {})
            self.assertEqual(status.call_args.kwargs['state'], 'verified')
            self.assertEqual(status.call_args.kwargs['new_pid'], 200)

    def test_stuck_process_is_not_force_killed_or_relaunched(self):
        with patch.object(restart, 'app_pids', return_value=[100]), \
             patch.object(restart, 'windows', return_value=[OLD]), \
             patch.object(restart.time, 'monotonic', side_effect=[0, 46]), \
             patch.object(restart.os, 'kill') as kill, \
             patch.object(restart, 'dispatch') as dispatch, \
             patch.object(restart, 'status'):
            with self.assertRaisesRegex(RuntimeError, 'did not exit gracefully'):
                restart.restart({})
            kill.assert_called_once_with(100, signal.SIGTERM)
            dispatch.assert_not_called()

    def test_launch_without_window_is_failure(self):
        with patch.object(restart, 'app_pids', side_effect=[[100], [], []]), \
             patch.object(restart, 'windows', return_value=[OLD]), \
             patch.object(restart.time, 'monotonic', side_effect=[0, 1, 92]), \
             patch.object(restart.os, 'kill'), \
             patch.object(restart, 'dispatch'), \
             patch.object(restart, 'status') as status:
            with self.assertRaisesRegex(RuntimeError, 'No new mapped'):
                restart.restart({})
            self.assertFalse(any(call.kwargs.get('state') == 'verified' for call in status.call_args_list))


if __name__ == '__main__':
    unittest.main()
