"""Execute the real TS timing helpers without adding a second JS test framework."""
from pathlib import Path
import subprocess
import unittest


class TimingTests(unittest.TestCase):
    def test_subtitle_selection_and_growth_cues_have_independent_boundaries(self):
        root = Path(__file__).parents[1]
        result = subprocess.run(['node', '--input-type=module', '-e', '''
import ts from 'typescript';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const code = ts.transpileModule(readFileSync('src/timing.ts', 'utf8'), {
  compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022}
}).outputText;
const {activeLine, latestCue} = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const scene = {lines: [{id:'a', from:0, durationInFrames:60, visual:'growth'},
  {id:'b', from:60, durationInFrames:60, visual:'growth'},
  {id:'c', from:120, durationInFrames:60, visual:'hero'}],
  cues:[{id:'day-1',frame:65},{id:'day-7',frame:85},{id:'day-100',frame:100}]};
assert.equal(activeLine(scene, 60).id, 'b');
assert.equal(activeLine(scene, 59).id, 'a');
assert.equal(latestCue(scene, ['day-1','day-7','day-100'], 60), undefined);
assert.equal(latestCue(scene, ['day-1','day-7','day-100'], 65).id, 'day-1');
assert.equal(latestCue(scene, ['day-1','day-7','day-100'], 64), undefined);
assert.equal(latestCue(scene, ['day-1','day-7','day-100'], 85).id, 'day-7');
assert.equal(latestCue(scene, ['day-1','day-7','day-100'], 179).id, 'day-100');
'''], cwd=root, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
