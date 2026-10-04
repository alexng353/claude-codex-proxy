#!/usr/bin/env python3
"""Install into Alex's existing fail-closed patch manager, backing up first."""
from datetime import datetime
from pathlib import Path
import shutil

root = Path.home() / '.local/share/codex-patches'
source = Path(__file__).resolve().parent
backup = root / 'state' / ('backup-compaction-' + datetime.now().strftime('%Y%m%dT%H%M%S'))
backup.mkdir()

def replace_once(text, before, after):
    if text.count(before) != 1:
        raise RuntimeError('Patch-manager anchor changed: ' + before)
    return text.replace(before, after, 1)

patches = (root / 'patches.py').read_text()
manager = (root / 'manager.py').read_text()
if 'from compaction.patch import apply as apply_compaction' not in patches:
    patches = replace_once(patches, 'from pathlib import Path', 'from compaction.patch import apply as apply_compaction\nfrom pathlib import Path')
    patches = replace_once(patches, 'return list(dict.fromkeys(str(f.relative_to(tree)) for f in files))', 'return list(dict.fromkeys(str(f.relative_to(tree)) for f in files)) + apply_compaction(tree)')
if "'compaction/queue.cjs'" not in manager:
    manager = replace_once(manager, "'model-presets.json']", "'model-presets.json','compaction/patch.py','compaction/queue.cjs']")
for name in ['patches.py', 'manager.py']:
    shutil.copy2(root / name, backup / name)
if (root / 'compaction').exists():
    shutil.copytree(root / 'compaction', backup / 'compaction')
target = root / 'compaction'
target.mkdir(exist_ok=True)
for name in ['patch.py', 'queue.cjs']:
    shutil.copy2(source / name, target / name)
(root / 'patches.py').write_text(patches)
(root / 'manager.py').write_text(manager)
print('Installed compaction integration; backups:', backup)
print('Run python3 manager.py apply --no-repair in', root)
