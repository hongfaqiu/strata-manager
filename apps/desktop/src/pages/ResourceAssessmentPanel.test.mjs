import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const jsx = (type, props) => ({ type, props: props ?? {} });
const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)];
const textOf = tree => tree == null ? '' : typeof tree !== 'object' ? String(tree) : [tree.props?.children].flat(Infinity).map(textOf).join(' ');
const visibleText = tree => tree == null ? '' : typeof tree !== 'object' ? String(tree) : tree.type === 'details' && !tree.props.open ? textOf(nodes(tree).find(node => node.type === 'summary')) : [tree.props?.children].flat(Infinity).map(visibleText).join(' ');
const source = ts.transpileModule(readFileSync(new URL('./ResourceAssessmentPanel.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
const request = { installationId:'fixture',family:'qwen',quant:'Q2_0',context:32768,images:false,kv:'int8',gpuIds:[0],parallel:1 };
const assessment = {
  status:'suggested',sampledAt:1000,estimate:true,sourceRevision:'revision',
  hardware:{totalMemoryBytes:64*1024**3,availableMemoryBytes:50*1024**3,gpus:[{id:0,name:'Fixture GPU',totalBytes:24*1024**3,availableBytes:null}],cpuIsa:'avx2',wsl:false},
  ram:{baselineBytes:48*1024**3,expertBytes:34*10**9,longContextBytes:null,mode:'normal'},
  kv:{streaming:false,streamingRamBytes:0},slots:{count:1,perSlotVramBytes:null,totalVramBytes:null},recommendations:{context:131072,parallel:3},reasons:[],unknowns:[],
};
function fixture(query = {}, historyRows = []) {
  const slots=[], queries=[], storeKeys=[]; let cursor=0;
  const module={exports:{}};
  vm.runInNewContext(source,{module,exports:module.exports,setTimeout,clearTimeout,Date,require: name => {
    if(name.endsWith('.css'))return {};
    return {
      react:{useState:value=>{ const index=cursor++; slots[index] ??= value; return [slots[index],next=>{slots[index]=next;}]; },useEffect:()=>{},useMemo:fn=>fn()},
      'react/jsx-runtime':{jsx,jsxs:jsx}, 'lucide-react':{RefreshCw:'RefreshCw',CircleHelp:'CircleHelp'},
      './SetupDiskStatus':{SetupDiskStatus:'SetupDiskStatus'},
      '@tanstack/react-query':{useQuery:options=>{queries.push(options);return {data:assessment,isFetching:false,isPending:false,refetch:()=>{},...query};}},
      '@strata-manager/core':{isDesktop:()=>true,loadStore:key=>{storeKeys.push(key);return Promise.resolve([]);},matchingResourceMeasurements:()=>historyRows,assessSetupResources:()=>{throw Error('No real backend');},normalizeError:error=>({message:String(error)}),resourceAssessmentMessage:(code,zh)=>`${zh?'说明':'Note'} ${code}`},
    }[name] ?? {};
  }});
  return {render:props=>{cursor=0;return module.exports.ResourceAssessmentPanel({request,language:'zh-CN',...props});},queries,storeKeys};
}
test('shows source, total and unknown free VRAM with explicit recommendations',()=>{
  const fixtureUI=fixture(),tree=fixtureUI.render({});
  assert.match(textOf(tree),/适合尝试/); assert.match(textOf(tree),/Fixture GPU/); assert.match(textOf(tree),/未知/);
  assert.match(textOf(tree),/建议不会自动修改/);
  assert.equal(nodes(tree).find(node=>node.type==='a').props.href,'https://github.com/Niko1221/Strata/blob/revision/setup.py');
});
test('changing an unsaved draft hides late prior-request recommendations',()=>{
  const fixtureUI=fixture();fixtureUI.render({});
  const tree=fixtureUI.render({request:{...request,context:262144}});
  assert.match(textOf(tree),/正在更新预估/); assert.doesNotMatch(textOf(tree),/131K|128K|适合尝试/);
  assert.equal(fixtureUI.queries.at(-1).enabled,false);
});
test('invalid drafts and browser previews do not query or reuse saved estimates',()=>{
  const fixtureUI=fixture();
  assert.match(textOf(fixtureUI.render({request:null})),/容量预估显示为未知/);
  assert.equal(fixtureUI.queries.at(-1).enabled,false);
  assert.match(textOf(fixtureUI.render({desktop:false})),/需要桌面后台/);
  assert.equal(fixtureUI.queries.at(-1).enabled,false);
});
test('backend errors keep capacity unknown and retain a manual retry entry',()=>{
  const tree=fixture({error:new Error('fixture failure'),data:undefined}).render({});
  assert.match(textOf(tree),/容量保持未知/);
  assert.equal(nodes(tree).find(node=>node.type==='button').props.disabled,false);
});
test('history displays only prefiltered matches and labels whole-host sampled peaks',()=>{
  const tree=fixture({},[{id:'measurement',startedAt:1000,ramPeakBytes:20*1024**3,vramPeakBytes:null}]).render({});
  assert.match(textOf(tree),/相同资源选择的历史实测/);assert.match(textOf(tree),/20 GiB/);assert.match(textOf(tree),/整机／整卡采样/);
  assert.match(textOf(fixture().render({})),/缺少证据的旧报告和不同资源选择不会作为匹配结果/);
});
test('reads the same persisted report key as the scenario benchmark workspace',async()=>{
  const fixtureUI=fixture();fixtureUI.render({});
  await fixtureUI.queries.find(query=>query.queryKey[0]==='benchmark-resource-history').queryFn();
  assert.deepEqual(fixtureUI.storeKeys,['benchmarkReportsV1']);
  const scenario=readFileSync(new URL('./ScenarioBenchmarkPage.tsx',import.meta.url),'utf8');
  assert.match(scenario,/['"]benchmarkReportsV1['"]/);
});

const disk = {status:'ready',dataDirectory:'D:/fixture',modelDirectory:'D:/fixture/models',modelDownloadBytesEstimate:30*1024**3,reusableModelBytes:0,additionalBytesEstimate:40*1024**3,estimate:true,volumes:[{directory:'D:/fixture',mountPoint:'D:/',availableBytes:80*1024**3,requiredAdditionalBytesEstimate:40*1024**3}],reason:'fixture disk reason',source:'fixture'};

test('compact guidance summarizes three metrics while one disclosure retains detailed evidence',()=>{
  const onRefreshDisk=()=>{},tree=fixture({},[{id:'measurement',startedAt:1000,ramPeakBytes:20*1024**3,vramPeakBytes:null}]).render({compact:true,disk,onRefreshDisk});
  const visible=visibleText(tree),disclosure=nodes(tree).find(node=>node.type==='details');
  assert.match(visible,/当前选择的资源预估/);assert.match(visible,/本机可用 RAM/);assert.match(visible,/50 GiB/);assert.match(visible,/官方 RAM 建议阈值/);assert.match(visible,/磁盘空间/);assert.match(visible,/充足/);
  assert.match(visible,/参考值不等于运行保证/);
  assert.doesNotMatch(visible,/Fixture GPU|专家权重规模|相同资源选择的历史实测/);
  assert.equal(nodes(tree).filter(node=>node.type==='details').length,1);
  assert.equal(disclosure.props.open,undefined);assert.match(textOf(disclosure),/查看分项与依据/);
  assert.match(textOf(disclosure),/Fixture GPU|专家权重规模/);assert.match(textOf(disclosure),/相同资源选择的历史实测/);assert.match(textOf(disclosure),/20 GiB/);
  assert.equal(nodes(disclosure).find(node=>node.type==='a').props.href,'https://github.com/Niko1221/Strata/blob/revision/setup.py');
  const diskDetails=nodes(disclosure).find(node=>node.type==='SetupDiskStatus');
  assert.equal(diskDetails.props.data,disk);assert.equal(diskDetails.props.onRefresh,onRefreshDisk);
});

test('compact risk guidance leaves its primary reason visible and retains every reason inside the disclosure',()=>{
  const data={...assessment,status:'risk',reasons:[{code:'estimate_scope',severity:'info'},{code:'ram_low',severity:'risk'},{code:'vram_low',severity:'risk'}],unknowns:['gpu_unknown']};
  const tree=fixture({data}).render({compact:true});
  assert.match(visibleText(tree),/存在资源风险/);assert.match(visibleText(tree),/ram_low/);
  const disclosure=nodes(tree).find(node=>node.type==='details');
  for(const code of ['ram_low','vram_low','gpu_unknown','estimate_scope'])assert.match(textOf(disclosure),new RegExp(code));
});

test('compact disk summary never reuses a successful result while pending or failed',()=>{
  for(const [props,expected] of [[{},'未检查'],[{diskPending:true},'检查中'],[{disk},'充足'],[{disk:{...disk,status:'insufficient'}},'不足'],[{disk:{...disk,status:'unknown'}},'未知'],[{disk,diskPending:true},'检查中'],[{disk,diskError:new Error('disk failure')},'检查失败']]){
    const tree=fixture().render({compact:true,...props});
    assert.match(visibleText(tree),new RegExp(expected));
    if(props.diskPending||props.diskError){
      assert.doesNotMatch(visibleText(tree),/充足/);
      assert.equal(nodes(tree).find(node=>node.type==='SetupDiskStatus').props.data,undefined);
    }
  }
});

test('compact unknown and failure states cannot advertise stale RAM recommendations',()=>{
  for(const props of [{request:null},{desktop:false}]){
    const tree=fixture().render({compact:true,...props});
    assert.equal(tree.props['data-status'],'unknown');assert.doesNotMatch(visibleText(tree),/50 GiB|48 GiB|适合尝试/);
  }
  const failed=fixture({error:new Error('resource failure'),data:assessment}).render({compact:true});
  assert.equal(failed.props['data-status'],'unknown');assert.match(visibleText(failed),/容量保持未知/);assert.doesNotMatch(visibleText(failed),/50 GiB|48 GiB|适合尝试/);
});

test('disk refreshes preserve the same resource sample and resource query identity',()=>{
  const fixtureUI=fixture();fixtureUI.render({compact:true,disk});
  const firstQuery=fixtureUI.queries.find(query=>query.queryKey[0]==='resource-assessment');
  const tree=fixtureUI.render({compact:true,diskPending:true,disk});
  const lastQuery=fixtureUI.queries.filter(query=>query.queryKey[0]==='resource-assessment').at(-1);
  assert.deepEqual(lastQuery.queryKey,firstQuery.queryKey);assert.equal(lastQuery.enabled,true);
  assert.match(visibleText(tree),/50 GiB/);assert.match(visibleText(tree),/适合尝试/);assert.doesNotMatch(visibleText(tree),/正在更新预估/);
});
