/** Creates an isolated no-inference Python runtime to verify native ownership and cleanup. */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve('.local/native-fixture');
await mkdir(join(root, 'serve'), { recursive: true });
await mkdir(join(root, 'tokenizer'), { recursive: true });
for (const name of ['vocab.json', 'merges.txt', 'token_type.json']) await writeFile(join(root, 'tokenizer', name), name.endsWith('.json') ? '{}' : '');
await writeFile(join(root, 'serve/__init__.py'), '');
await writeFile(join(root, 'setup.py'), 'import sys\nprint("Native ownership fixture only; no model download", sys.argv[1:])\n');
await writeFile(join(root, 'model.fixture'), 'Not a model: used only for lifecycle tests.');
const python = process.env.STRATA_FIXTURE_PYTHON || spawnSync(process.platform === 'win32' ? 'py' : 'python3', ['-I', '-S', '-c', 'import sys;print(sys.executable)'], { encoding: 'utf8', windowsHide: true }).stdout?.trim();
if (!python) throw new Error('A real Python 3 interpreter is required for the isolated lifecycle fixture.');
await writeFile(join(root, 'strata-fixture.json'), JSON.stringify({
  exe: python, args: ['--model', join(root, 'model.fixture')], cwd: root, tokenizer: join(root, 'tokenizer'), port: 18092, host: '127.0.0.1',
  model_name: 'native-lifecycle-fixture', lazy_load: true, api_monitor: false,
}, null, 2));
await writeFile(join(root, 'serve/server.py'), `import argparse, json, os, signal, subprocess, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
p=argparse.ArgumentParser()
p.add_argument('--engine');p.add_argument('--config');p.add_argument('--host',default='127.0.0.1');p.add_argument('--port',type=int,default=18092);p.add_argument('--api-monitor',action='store_true')
a=p.parse_args()
child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(3600)'])
with open(os.path.join(os.path.dirname(a.config),'child.pid'),'w') as f:f.write(str(child.pid))
loaded=False
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  if self.path=='/health': self.send_json({'status':'ok','service':'strata','loaded':loaded,'model':'native-lifecycle-fixture','images':False,'max_context':32768})
  elif self.path=='/v1/status': self.send_json({'service':'strata','loaded':loaded,'activity':{'in_flight':0}})
  elif self.path=='/metrics': self.send_json({'live':{'state':'idle' if loaded else 'unloaded','queued':0},'requests':[]})
  elif self.path=='/mcp': self.send_json({'servers':[],'tools':0})
  else: self.send_json({'error':{'message':'Fixture route unavailable'}},404)
 def do_POST(self):
  global loaded
  self.rfile.read(int(self.headers.get('Content-Length',0)))
  if self.path in ('/load','/v1/load','/unload','/v1/unload'):
   loaded=not self.path.endswith('unload');self.send_json({'loaded':loaded,'status':'loaded' if loaded else 'unloaded'})
  else:self.send_json({'error':{'message':'Fixture route unavailable'}},404)
 def send_json(self,data,code=200):
  body=json.dumps(data).encode();self.send_response(code);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
print('Native lifecycle fixture started, child PID',child.pid,flush=True)
ThreadingHTTPServer((a.host,a.port),Handler).serve_forever()
`);
process.stdout.write(JSON.stringify({ installDir: root, configPath: join(root, 'strata-fixture.json'), baseUrl: 'http://127.0.0.1:18092' }) + '\n');
