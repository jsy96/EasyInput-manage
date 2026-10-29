import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

const sourceDir = resolve('firmware/easyinput-monitor/main')
const builder = resolve('scripts/build-voice-prompts.py')

it('reads every retained prompt by its original ID in the actual C pack reader', () => {
  const root = mkdtempSync(join(tmpdir(), 'easyinput-prompt-reader-'))
  try {
    const packPath = join(sourceDir, 'assets/prompts.bin')
    const pack = readFileSync(packPath)
    expect(pack.readUInt32LE(0)).toBe(0x31504945)
    expect(pack.readUInt16LE(4)).toBe(1)
    expect(pack.readUInt16LE(6)).toBe(167)
    const manifest: { texts: Record<string, string>, retired: number[] } = JSON.parse(execFileSync('python3', [
      '-B', '-c', 'import json, runpy, sys; m=runpy.run_path(sys.argv[1]); print(json.dumps({"texts":m["TEXTS"],"retired":sorted(m["RETIRED_PROMPT_IDS"])}))', builder,
    ], { encoding: 'utf8' }))
    const entries = Array.from({ length: pack.readUInt16LE(6) }, (_, i) => ({
      id: pack.readUInt16LE(8 + i * 10),
      offset: pack.readUInt32LE(10 + i * 10),
      length: pack.readUInt32LE(14 + i * 10),
    }))
    expect(entries.map(e => e.id)).toEqual(Object.keys(manifest.texts).map(Number).sort((a, b) => a - b))
    expect(manifest.retired).toHaveLength(42)
    expect(manifest.texts['202']).toBe('失败')
    expect(manifest.texts['33']).toBe('录音保存失败，请保持供电')
    let offset = 8 + entries.length * 10
    for (const entry of entries) {
      expect(entry.offset).toBe(offset)
      expect(entry.length).toBeGreaterThan(0)
      offset += entry.length
    }
    expect(offset).toBe(pack.length)

    writeFileSync(join(root, 'pack.S'), `.data
.global _binary_prompts_bin_start
_binary_prompts_bin_start:
.incbin ${JSON.stringify(packPath)}
.global _binary_prompts_bin_end
_binary_prompts_bin_end:
`)
    const header = readFileSync(join(sourceDir, 'voice_prompts.h'), 'utf8')
    const namedPrompts = Array.from(header.matchAll(/^\s+(PROMPT_\w+)\s*=/gm), match => match[1])
      .filter(name => name !== 'PROMPT_COUNT')
    writeFileSync(join(root, 'test.c'), `
#include <assert.h>
#include <stdio.h>
#include "voice_prompts.h"
extern const uint8_t pack_start[] asm("_binary_prompts_bin_start");
_Static_assert(PROMPT_HUNDRED == 32 && PROMPT_ALARM_TIME_0 == 39 && PROMPT_TIMER_MINUTE_1 == 87, "timer IDs must not shift");
_Static_assert(PROMPT_VOLUME_10 == 151 && PROMPT_RECORD_CANCELLED == 176 && PROMPT_STT_START == 184, "IDs after gaps must not shift");
_Static_assert(PROMPT_TRANSCRIPT_FAILURE == 202 && PROMPT_ALARM_MELODY == 208 && PROMPT_COUNT == 209, "tail IDs must not shift");
int main(void) {
  const struct { int id; size_t offset, length; } entries[] = {
    ${entries.map(e => `{${e.id},${e.offset},${e.length}}`).join(',')}
  };
  for (size_t i=0;i<sizeof(entries)/sizeof(entries[0]);i++) {
    size_t length=0;
    const uint8_t *data=voice_prompt_data(entries[i].id,&length);
    assert(data && length>0 && data>=pack_start+entries[i].offset);
    assert(data+length<=pack_start+entries[i].offset+entries[i].length);
  }
  const int named[]={${namedPrompts.join(',')}};
  for(size_t i=0;i<sizeof(named)/sizeof(named[0]);i++) {
    size_t length=0;assert(voice_prompt_data(named[i],&length) && length);
  }
  const int absent[]={-1,PROMPT_COUNT,${manifest.retired.join(',')}};
  for(size_t i=0;i<sizeof(absent)/sizeof(absent[0]);i++) {
    size_t length=123;assert(!voice_prompt_data(absent[i],&length) && length==0);
  }
  assert(!voice_prompt_data(PROMPT_RECORDING,NULL));
  puts("sparse prompt reader checks passed");
}
`)
    execFileSync('cc', ['-std=gnu11', '-Wall', '-Wextra', '-Werror', '-I', sourceDir,
      join(sourceDir, 'voice_prompts.c'), join(root, 'test.c'), join(root, 'pack.S'), '-o', join(root, 'test')], { encoding: 'utf8' })
    expect(execFileSync(join(root, 'test'), [], { encoding: 'utf8' })).toContain('sparse prompt reader checks passed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('compacts legacy packs, reuses sparse audio and refreshes fixed IDs without TTS during cleanup', () => {
  const root = mkdtempSync(join(tmpdir(), 'easyinput-prompt-builder-'))
  try {
    const result = execFileSync('python3', ['-B', '-c', `
import contextlib, io, runpy, struct, sys
from pathlib import Path
from unittest.mock import patch
m=runpy.run_path(sys.argv[1])
main=m['main']
root=Path(sys.argv[2])
pack=root/'prompts.bin'
tts=root/'fake-tts.py'
original={i:bytes([i])*(20+i%3) for i in range(209)}
m['write_pack'](pack,original)
texts=m['TEXTS']
retired=m['RETIRED_PROMPT_IDS']
assert not texts.keys() & retired
assert texts.keys() | retired == set(original)
def run(*options):
    with patch.object(sys,'argv',[sys.argv[1],'--output',str(pack),'--reuse-existing','--tts-script',str(tts),*options]), contextlib.redirect_stdout(io.StringIO()):
        main()
with patch.dict(main.__globals__,synthesize=lambda *a: (_ for _ in ()).throw(AssertionError('cleanup must not use TTS'))):
    run()
    expected={i:data for i,data in original.items() if i in texts}
    assert m['load_existing'](pack)==expected
    compact=pack.read_bytes()
    run()
    assert pack.read_bytes()==compact

# Refresh uses permanent IDs even when an ID is higher than the entry count.
tts.write_text('not executed')
calls=[]
def fake_synthesize(script,text,output,voice,rate):
    calls.append(text)
def fake_ulaw(source,output):
    output.write_bytes(b'refreshed')
with patch.dict(main.__globals__,synthesize=fake_synthesize,to_ulaw=fake_ulaw,make_alarm_melody=lambda p:p.write_bytes(b'melody')), patch.object(main.__globals__['time'],'sleep',lambda n:None):
    run('--refresh-index','202')
    assert calls==['失败']
    expected[202]=b'refreshed'
    assert m['load_existing'](pack)==expected
    calls.clear()
    run('--refresh-first','25')
    first=sorted(texts)[:25]
    assert calls==[texts[i] for i in first] and first[-1]==32
    for i in first: expected[i]=b'refreshed'
    assert m['load_existing'](pack)==expected
    calls.clear()
    run('--refresh-from','198')
    assert calls==[texts[i] for i in sorted(texts) if 198<=i<208]
    for i in texts:
        if i>=198: expected[i]=b'refreshed'
    assert m['load_existing'](pack)==expected
    # Missing active IDs are restored without changing their neighbors.
    missing=dict(expected)
    del missing[176]
    m['write_pack'](pack,missing)
    calls.clear()
    run()
    expected[176]=b'refreshed'
    assert calls==[texts[176]] and m['load_existing'](pack)==expected

# Invalid fixed IDs and malformed packs must fail before overwriting the file.
def reject(action):
    before=pack.read_bytes()
    try: action()
    except SystemExit: pass
    else: raise AssertionError('expected rejection')
    assert pack.read_bytes()==before
reject(lambda:run('--refresh-index','24'))
reject(lambda:run('--refresh-from','161'))
m['write_pack'](pack,{**expected,999:b'unknown'})
reject(run)
for corrupt in [b'',struct.pack('<IHH',0x31504945,1,2),
    struct.pack('<IHHHII',0x31504945,1,1,0,8,1)+b'x',
    struct.pack('<IHH',0x31504945,1,2)+struct.pack('<HII',0,28,1)*2+b'x',
    struct.pack('<IHH',0x31504945,1,2)+struct.pack('<HII',0,28,2)+struct.pack('<HII',1,29,1)+b'xx']:
    pack.write_bytes(corrupt)
    reject(lambda:m['load_existing'](pack))
print('prompt migration and fixed ID refresh checks passed')
`, builder, root], { encoding: 'utf8' })
    expect(result).toContain('prompt migration and fixed ID refresh checks passed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
