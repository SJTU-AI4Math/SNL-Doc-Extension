#!/usr/bin/env python3
"""Create an exclusively-owned non-Git snapshot; never build the live checkout.
Usage: python3 scripts/browser-author-overlay.py /absolute/evidence-root [revision]
Then run the printed commands through the campaign verify.py admission lock.
Dependencies are borrowed read-only. No installation, Vite temp loader or cache writes.
"""
import hashlib, json, pathlib, subprocess, sys, tarfile, io, shutil
repo = pathlib.Path(__file__).resolve().parent.parent
out = pathlib.Path(sys.argv[1]).resolve()
revision = sys.argv[2] if len(sys.argv)>2 else 'HEAD'
out.mkdir(parents=True, exist_ok=True)
source=out/'source'
source.mkdir(exist_ok=False)
paths=['src','webview/src','webview/tsconfig.json','webview/productionEntries.json','webview/vite.config.ts','scripts','resources/kind-presets','media/icons','package.json','package-lock.json','tsconfig.json']
data=subprocess.check_output(['git','archive',revision,'--',*paths],cwd=repo)
with tarfile.open(fileobj=io.BytesIO(data)) as archive: archive.extractall(source,filter='data')
for pattern in ['browser-author-*','test-collapsible-production-*','test-relationship-production-browser.*','test-local-reader-author.*']:
 for f in (repo/'scripts').glob(pattern): shutil.copy2(f,source/'scripts'/f.name)
(source/'node_modules').symlink_to(repo/'node_modules',target_is_directory=True)
manifest={str(f.relative_to(source)):hashlib.sha256(f.read_bytes()).hexdigest() for f in source.rglob('*') if f.is_file() and not f.is_symlink()}
identity={'revision':subprocess.check_output(['git','rev-parse',revision],cwd=repo,text=True).strip(),'source':str(source),'dependencyRoot':str(repo/'node_modules'),'files':manifest}
(source/'.browser-author-overlay.json').write_text(json.dumps(identity,indent=2)+'\n')
(out/'source-identity.json').write_text(json.dumps(identity,indent=2)+'\n')
print(source)
