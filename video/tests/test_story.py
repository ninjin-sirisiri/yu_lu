"""Regressions for stable headings and distinct send/receive actors."""
from pathlib import Path
import subprocess
import unittest


class StoryTests(unittest.TestCase):
    def test_receive_never_reuses_the_send_peer(self):
        result = subprocess.run(['node', '--input-type=module', '-e', '''
import {buildSync} from 'esbuild';
import assert from 'node:assert/strict';
const code=buildSync({entryPoints:['src/story.ts'],bundle:true,write:false,platform:'node',format:'esm'}).outputFiles[0].text;
const {storyState} = await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const scene={id:'concept',title:'毎日の相手が決まる仕組み',lines:[
 {id:'a',from:0,durationInFrames:90,headline:'最初の字幕用見出し',visual:'assignment'},
 {id:'b',from:90,durationInFrames:90,headline:'次の字幕用見出し',visual:'assignment'},
 {id:'c',from:180,durationInFrames:90,headline:'最後の字幕用見出し',visual:'assignment'}],
 cues:[{id:'outgoing',frame:30},{id:'send',frame:100},{id:'reply',frame:130},{id:'free',frame:220}]};
assert.deepEqual(storyState(scene,29).flows,[]);
assert.equal(storyState(scene,30).flows[0].at,30);
assert.deepEqual(storyState(scene,100).flows.map(e=>[e.from,e.to]),[['self','friend-a']]);
const received=storyState(scene,130);
assert.equal(received.phase,'receive');
assert.deepEqual(received.actors,['friend-b','self','friend-a']);
assert.deepEqual(received.flows.map(e=>[e.from,e.to]),[['self','friend-a'],['friend-b','self']]);
assert.equal(received.flows.some(e=>e.from==='friend-a'&&e.to==='self'),false);
assert.equal(received.flows.some(e=>e.from==='self'&&e.to==='friend-b'),false);
assert.equal(storyState(scene,180).phase,'receive'); // retain explanation over subtitle change
assert.equal(storyState(scene,220).phase,'free');
assert.deepEqual(storyState(scene,220).flows,[]); // no daily arrows on unrestricted chat diagram
'''], cwd=Path(__file__).parents[1], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rendered_diagram_has_three_people_and_fixed_title_not_swapped_labels(self):
        result = subprocess.run(['node', '--input-type=module', '-e', '''
import {buildSync} from 'esbuild';
import {createRequire} from 'node:module';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import assert from 'node:assert/strict';
const require=createRequire(process.cwd()+'/package.json');
const load=entry=>{const code=buildSync({entryPoints:[entry],bundle:true,write:false,platform:'node',format:'cjs',packages:'external'}).outputFiles[0].text;
 const m={exports:{}};new Function('require','module','exports',code)(require,m,m.exports);return m.exports;};
const {AssignmentBoard}=load('./src/visuals/Assignment.tsx');
const {ChapterHeader}=load('./src/visuals/elements.tsx');
const {Reliability}=load('./src/visuals/Engineering.tsx');
const scene={id:'concept',title:'毎日の相手が決まる仕組み',chapter:'03 / 仕組み',durationInFrames:700,
lines:[{from:0,durationInFrames:300,headline:'送り先の字幕'},{from:300,durationInFrames:400,headline:'受信の字幕'}],
cues:[{id:'approved',frame:40},{id:'outgoing',frame:180},{id:'send',frame:260},{id:'reply',frame:340},{id:'free',frame:620}]};
for(const frame of [320,390,500]){
 const html=renderToStaticMarkup(React.createElement(AssignmentBoard,{scene,frame,fps:30}));
 for(const id of ['self','friend-a','friend-b'])assert.equal((html.match(new RegExp('data-actor="'+id+'"','g'))||[]).length,1);
 if(frame>=340){assert.ok(html.includes('data-flow="self:friend-a"'));assert.ok(html.includes('data-flow="friend-b:self"'));
 assert.ok(!html.includes('data-flow="friend-a:self"'));assert.ok(!html.includes('data-flow="self:friend-b"'));}
 const title=renderToStaticMarkup(React.createElement(ChapterHeader,{scene,frame,fps:30}));
 assert.ok(title.includes('毎日の相手が決まる仕組み'));assert.ok(!title.includes('字幕'));
}
const queueScene={...scene,id:'reliability',cues:[{id:'draft',frame:30},{id:'saved',frame:60},
 {id:'offline',frame:90},{id:'queued',frame:120},{id:'reconnect',frame:180},{id:'confirmed',frame:300}]};
const arrivals=renderToStaticMarkup(React.createElement(Reliability,{scene:queueScene,frame:270,fps:30}));
for(const item of [0,1,2]){
 const style=arrivals.match(new RegExp('data-queue-item="'+item+'" style="([^"]+)"'))?.[1];
 assert.ok(style?.includes('opacity:1'), 'Arrived item '+item+' must remain visible until status comparison');
}
'''], cwd=Path(__file__).parents[1], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
