import { describe, expect, it } from 'vitest';
import {
  BUILTIN_COMMUNITY_MODELS, MAC_SETUP_QUANTS, SUPPORTED_QUANTS, communityAvailability, communityFromTree, communityModelName,
  communityQuantAvailability, communitySetupRequest, inferFamily, platformQuants, isKnownRepo, mergeCommunityModels, officialFamilyBlock, quantOfStem, setupSupports,
} from '../src/community-catalog';
import type { HfTreeEntry } from '../src/community-catalog';

const sha = (n: number) => n.toString(16).padStart(64, '0');
const REV = 'a'.repeat(40);
const GB = 1_000_000_000;

describe('built-in community entries', () => {
  it('pins a 40-hex revision and hashes every shard of every quant', () => {
    for (const model of BUILTIN_COMMUNITY_MODELS) {
      expect(model.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(model.risks.length).toBeGreaterThan(0);
      for (const quant of model.quants) {
        expect(SUPPORTED_QUANTS as readonly string[]).toContain(quant);
        if (model.kind === 'orca') continue;
        expect(setupSupports(model.family, quant)).toBe(true);
        const files = model.quantInfo[quant]!.files;
        expect(files.length).toBeGreaterThan(0);
        for (const file of files) { expect(file.sha256).toMatch(/^[0-9a-f]{64}$/); expect(file.size).toBeGreaterThan(0); }
      }
    }
  });
  it('lists SC117 with all four GSQ-RCO quants and the documented risks', () => {
    const sc117 = BUILTIN_COMMUNITY_MODELS.find(model => model.id === 'sc117-abliterated')!;
    expect(sc117.quants).toEqual(['Q2_0', 'IQ2_XS', 'IQ3_XXS', 'IQ3_S']);
    expect(sc117.risks).toEqual(expect.arrayContaining(['mtpNotAbliterated', 'agentPersistence']));
    expect(sc117.quantInfo.Q2_0!.files.map(file => file.path)).toEqual([
      'Q2_0/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-Q2_0-00001-of-00002.gguf',
      'Q2_0/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-Q2_0-00002-of-00002.gguf',
    ]);
  });
  it('blocks OrcaRouter and the control vector on Mac with a reason, but not on Windows', () => {
    const orca = BUILTIN_COMMUNITY_MODELS.find(model => model.kind === 'orca')!;
    const alesha = BUILTIN_COMMUNITY_MODELS.find(model => model.kind === 'control-vector')!;
    expect(communityAvailability(orca, 'macos')).toMatchObject({ downloadable: false, reason: 'macGemv' });
    expect(communityAvailability(alesha, 'macos')).toMatchObject({ downloadable: false, reason: 'macControlVector' });
    expect(communityAvailability(orca, 'windows')).toMatchObject({ downloadable: false, reason: 'orcaImport' });
    expect(communityAvailability(alesha, 'windows').downloadable).toBe(true);
    expect(() => communitySetupRequest(orca, 'IQ3_XXS')).toThrow(/ORCA/);
  });
  it('limits Mac quants to what the Mac installer accepts', () => {
    const sc117 = BUILTIN_COMMUNITY_MODELS.find(model => model.id === 'sc117-abliterated')!;
    expect(communityQuantAvailability(sc117, 'IQ2_XS', 'macos')).toMatchObject({ downloadable: false, reason: 'macQuant' });
    expect(communityQuantAvailability(sc117, 'Q2_0', 'macos').downloadable).toBe(true);
    expect(communityQuantAvailability(sc117, 'IQ2_XS', 'windows').downloadable).toBe(true);
    expect(MAC_SETUP_QUANTS).not.toContain('IQ2_XS');
    // setup.py mac_control_setup takes only --family qwen: discovered Unsloth builds are listed but not installable on a Mac.
    const unsloth = { ...sc117, family: 'unsloth', quants: ['UD-Q4_K_XL'] };
    expect(communityQuantAvailability(unsloth, 'UD-Q4_K_XL', 'macos')).toMatchObject({ downloadable: false, reason: 'macQuant' });
    expect(platformQuants(['Q2_0', 'IQ2_XS', 'UD-IQ4_XS', 'UD-Q4_K_XL', 'Q8_0'], 'macos')).toEqual(['Q2_0', 'UD-Q4_K_XL']);
    expect(platformQuants(['Q2_0', 'IQ2_XS'], 'windows')).toEqual(['Q2_0', 'IQ2_XS']);
  });
  it('builds a setup request without a projector (setup uses the official one) and names the config', () => {
    const sc117 = BUILTIN_COMMUNITY_MODELS.find(model => model.id === 'sc117-abliterated')!;
    const request = communitySetupRequest(sc117, 'IQ3_S');
    expect(request).toMatchObject({ slug: sc117.slug, family: 'qwen', quant: 'IQ3_S', revision: sc117.revision });
    expect(request).not.toHaveProperty('mmproj');
    expect(communityModelName(sc117.slug, 'IQ3_S')).toBe(`community-${sc117.slug}-iq3_s`);
  });
  it('greys official Swift / Coder / Qwen3.6 out on Mac only', () => {
    for (const family of ['swift', 'coder', 'qwen36']) expect(officialFamilyBlock(family, 'macos')).toBe('macFamily');
    expect(officialFamilyBlock('qwen', 'macos')).toBeUndefined();
    expect(officialFamilyBlock('unsloth', 'macos')).toBeUndefined();
    expect(officialFamilyBlock('swift', 'windows')).toBeUndefined();
  });
});

describe('discovery parsing', () => {
  it('reads quants and families like setup.py / local_model.rs', () => {
    expect(quantOfStem('Qwen3.8-Flash-Next-GSQ-RCO-abliterated-IQ3_XXS')).toBe('IQ3_XXS');
    expect(quantOfStem('Qwen3.8-Flash-Next-UD-Q4_K_XL')).toBe('UD-Q4_K_XL');
    expect(quantOfStem('README')).toBeUndefined();
    expect(inferFamily('Qwen3.8-Flash-Next-GSQ-RCO-abliterated-Q2_0', 'Q2_0')).toBe('qwen');
    expect(inferFamily('Qwen3.8-Flash-Next-Swift-GSQ-RCO-IQ3_S', 'IQ3_S')).toBe('swift');
    expect(inferFamily('Qwen3.8-Flash-Next-UD-Q5_K_XL', 'UD-Q5_K_XL')).toBe('unsloth');
    expect(inferFamily('Qwen3.8-Flash-Next-abliterated-Q2_0', 'Q2_0')).toBeUndefined();   // not GSQ-RCO
    expect(inferFamily('Llama-GSQ-RCO-Q2_0', 'Q2_0')).toBeUndefined();
  });

  const shard = (dir: string, stem: string, i: number, n: number, size: number, oid = sha(i + n * 10)): HfTreeEntry =>
    ({ path: `${dir}/${stem}-0000${i}-of-0000${n}.gguf`, size, lfs: { oid, size } });

  it('returns one entry per family with complete hashed sets, judging size per set (Unsloth headers are tiny)', () => {
    const tree: HfTreeEntry[] = [
      shard('Q2_0', 'Qwen3.8-Flash-Next-GSQ-RCO-abliterated-Q2_0', 1, 2, 17 * GB),
      shard('Q2_0', 'Qwen3.8-Flash-Next-GSQ-RCO-abliterated-Q2_0', 2, 2, 28 * GB),
      shard('IQ3_S', 'Qwen3.8-Flash-Next-GSQ-RCO-abliterated-IQ3_S', 1, 2, 30 * GB),   // shard 2 missing
      shard('unsloth-UD-Q4_K_XL', 'Qwen3.8-Flash-Next-UD-Q4_K_XL', 1, 3, 10_900_000),
      shard('unsloth-UD-Q4_K_XL', 'Qwen3.8-Flash-Next-UD-Q4_K_XL', 2, 3, 49 * GB),
      shard('unsloth-UD-Q4_K_XL', 'Qwen3.8-Flash-Next-UD-Q4_K_XL', 3, 3, 40 * GB),
      { path: 'mmproj-Qwen3.8-Flash-Next-BF16.gguf', size: 900_000_000, lfs: { oid: sha(9), size: 900_000_000 } },
      { path: 'README.md', size: 10 },
    ];
    const entries = communityFromTree({ id: 'someone/Flash-Next-abliterated-GGUF', sha: REV, downloads: 5 }, tree);
    expect(entries.map(entry => [entry.family, entry.quants])).toEqual([['qwen', ['Q2_0']], ['unsloth', ['UD-Q4_K_XL']]]);
    expect(entries[0]).toMatchObject({ id: 'hf:someone/Flash-Next-abliterated-GGUF@qwen', name: 'someone · Flash-Next-abliterated', source: 'discovered', images: true, revision: REV });
    expect(entries[0]!.risks).toEqual(expect.arrayContaining(['unverified', 'noGuardrails']));
    expect(entries[1]!.slug.endsWith('-unsloth')).toBe(true);
    expect(entries[1]!.quantInfo['UD-Q4_K_XL']!.files).toHaveLength(3);
  });
  it('skips pruned repos, unhashed files, unpinned revisions and unsupported quants', () => {
    const good = [shard('Q2_0', 'Qwen3.8-Flash-Next-GSQ-RCO-Q2_0', 1, 1, 40 * GB)];
    expect(communityFromTree({ id: 'x/Flash-Next-REAP-288-GGUF', sha: REV }, good)).toEqual([]);
    expect(communityFromTree({ id: 'x/y', sha: 'main' }, good)).toEqual([]);
    expect(communityFromTree({ id: 'x/y', sha: REV }, [{ path: 'Qwen3.8-Flash-Next-GSQ-RCO-Q2_0.gguf', size: 40 * GB }])).toEqual([]);
    expect(communityFromTree({ id: 'x/y', sha: REV }, [shard('Q4_K_M', 'Qwen3.8-Flash-Next-GSQ-RCO-Q4_K_M', 1, 1, 40 * GB)])).toEqual([]);
    expect(communityFromTree({ id: 'x/y', sha: REV }, [shard('Q2_0', 'Qwen3.8-Flash-Next-GSQ-RCO-Q2_0', 1, 1, 200_000_000)])).toEqual([]);
    expect(communityFromTree({ id: 'x/y', sha: REV }, good)).toHaveLength(1);
  });
  it('merges built-ins first, drops official makers, and keeps only qwen/unsloth on Mac', () => {
    const qwen = communityFromTree({ id: 'a/q', sha: REV, downloads: 1 }, [shard('Q2_0', 'Qwen3.8-Flash-Next-GSQ-RCO-Q2_0', 1, 1, 40 * GB)])[0]!;
    const swift = communityFromTree({ id: 'b/s', sha: REV, downloads: 9 }, [shard('IQ3_S', 'Qwen3.8-Flash-Next-Swift-GSQ-RCO-IQ3_S', 1, 1, 60 * GB)])[0]!;
    const official = { ...qwen, id: 'hf:unsloth/x@qwen', repo: 'unsloth/x' };
    expect(isKnownRepo('ISTA-DASLab/anything')).toBe(true);
    const windows = mergeCommunityModels([qwen, swift, official], 'windows');
    expect(windows.slice(0, BUILTIN_COMMUNITY_MODELS.length).every(model => model.source === 'builtin')).toBe(true);
    expect(windows.slice(BUILTIN_COMMUNITY_MODELS.length).map(model => model.repo)).toEqual(['b/s', 'a/q']);
    expect(mergeCommunityModels([qwen, swift], 'macos').filter(model => model.source === 'discovered').map(model => model.repo)).toEqual(['a/q']);
  });
});
