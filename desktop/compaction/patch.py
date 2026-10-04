"""Exact anchors, staged by Alex's existing archive patch manager."""
from pathlib import Path
import subprocess


def apply(tree):
    root = Path(__file__).resolve().parent
    files = [p for p in (tree / '.vite/build').glob('main-*.js')
             if 'async callDynamicAppTool(e,t){' in p.read_text()]
    if len(files) != 1:
        raise RuntimeError('Compaction: expected exactly one desktop main bundle')
    path = files[0]
    source = path.read_text()
    if 'ALEX_CODEX_COMPACTION_V1' in source:
        raise RuntimeError('Compaction: use the saved unpatched baseline')
    def replace(before, after):
        nonlocal source
        if source.count(before) != 1:
            raise RuntimeError('Compaction anchor changed: ' + before[:100])
        source = source.replace(before, after, 1)
    helper = (root / 'queue.cjs').read_text().split('if (typeof module')[0]
    source = helper + '\n' + source
    tool = '{name:"compact_thread",namespace:"codex_app",description:"Compact a local Codex chat through Desktop. Defaults to the calling chat. Active chats queue until idle; returns queued or started (accepted, not completed). Duplicate pending requests coalesce. Queues survive restart; failures are recorded in ~/.local/state/codex-compaction/status.json. Cloud chats are unsupported.",inputSchema:{type:"object",properties:{threadId:{type:"string",description:"Codex thread UUID; omit for the calling chat"}},additionalProperties:false}}'
    replace('function sae(e){return e.flatMap(', 'function sae(e){return [' + tool + '].concat(e.flatMap(')
    replace('namespace:e.name})))}async function cae', 'namespace:e.name}))))}async function cae')
    replace('async callDynamicAppTool(e,t){return t.throwIfAborted(),', '''async callDynamicAppTool(e,t){
      if(e.params.namespace==="codex_app"&&e.params.tool==="compact_thread"){
        t.throwIfAborted();
        if(e.callerSource!=="codex"||e.hostId!=="local")throw Error("Compaction supports local Codex chats only");
        const args=e.params.arguments??{};
        if(typeof args!=="object"||Array.isArray(args)||Object.keys(args).some(k=>k!=="threadId"))throw Error("Invalid compaction arguments");
        const result=await this.alexCompactionQueue().request(args.threadId??e.params.threadId);
        return {success:true,contentItems:[{type:"inputText",text:JSON.stringify(result)}]};
      }
      return t.throwIfAborted(),''')
    replace('getLocalAppServerClient(){', '''alexCompactionQueue(){
      return this.alexCompactionState??=(alexCreateCompactionQueue({
        file:require("node:path").join(require("node:os").homedir(),".local/state/codex-compaction/status.json"),
        fs:require("node:fs"),client:()=>this.getLocalAppServerClient(),
        report:error=>console.error("Codex compaction failed",error)
      }));
    }getLocalAppServerClient(){''')
    replace('setDynamicAppToolsPipePath(e){this.conversationExecutor.setAppToolsPipePath(e)}', '''setDynamicAppToolsPipePath(e){
      this.conversationExecutor.setAppToolsPipePath(e);
      const fs=require("node:fs"),dir=require("node:path").join(require("node:os").homedir(),".local/state/codex-compaction");
      fs.mkdirSync(dir,{recursive:true,mode:0o700});
      if(e!=null){fs.writeFileSync(dir+"/pipe",e,{mode:0o600});this.alexCompactionQueue().restore()}
      else fs.rmSync(dir+"/pipe",{force:true});
    }''')
    path.write_text(source)
    subprocess.run(['node', '--check', str(path)], check=True)
    return [str(path.relative_to(tree))]
