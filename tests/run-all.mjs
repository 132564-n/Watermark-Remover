import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const root=resolve(process.cwd());
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.wasm':'application/wasm','.onnx':'application/octet-stream','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml'};
const server=createServer((request,response)=>{
  const pathname=decodeURIComponent(new URL(request.url,'http://127.0.0.1').pathname);
  const relative=normalize(pathname==='/'?'index.html':pathname.replace(/^\/+/,''));
  const file=resolve(join(root,relative));
  if(!file.startsWith(root)||!existsSync(file)||!statSync(file).isFile()){response.writeHead(404);response.end('Not found');return;}
  response.writeHead(200,{'Content-Type':mime[extname(file).toLowerCase()]||'application/octet-stream','Cache-Control':'no-store'});
  createReadStream(file).pipe(response);
});

await new Promise(resolveListen=>server.listen(0,'127.0.0.1',resolveListen));
const {port}=server.address(),testUrl=`http://127.0.0.1:${port}/`;
const tests=['e2e-detection.mjs','e2e-watermark-matrix.mjs','e2e-watermark.mjs','e2e-complex.mjs','e2e-multi-region.mjs','e2e-ai-fallback.mjs'];
try{
  for(const test of tests){
    const exitCode=await new Promise((resolveExit,reject)=>{
      const child=spawn(process.execPath,[join(root,'tests',test)],{stdio:'inherit',env:{...process.env,WATERMARK_TEST_URL:testUrl}});
      child.on('error',reject);child.on('exit',code=>resolveExit(code??1));
    });
    if(exitCode)process.exitCode=exitCode;
    if(exitCode)break;
  }
}finally{
  await new Promise(resolveClose=>server.close(resolveClose));
}
