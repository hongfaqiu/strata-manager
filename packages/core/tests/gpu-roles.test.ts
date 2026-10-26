import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { gpuRoles as R, readConcurrencySettings, STARTUP_TUNING_FIELDS, applyStartupField, validateStartupConfiguration } from '../src';

// Strata v0.2.6 tests/data/gpu_roles_vectors.json (includes #3655 two_8gb / tiny_second): the same vectors upstream runs against strata_control/gpu_roles.py and apps/host.
const V = JSON.parse(readFileSync(new URL('./fixtures/gpu-roles-vectors-v0.2.6.json', import.meta.url), 'utf8'));
const roles = (d: Record<string, R.Role> | null | undefined) => d ? Object.fromEntries(Object.entries(d).map(([k, v]) => [Number(k), v])) as R.Roles : d;

describe('GPU roles (ported from Strata 0.2.2)', () => {
  it('passes the upstream vectors', () => {
    for (const c of V.recommend) { const r = R.recommend(V.hw[c.hw]); expect([r.roles, r.main, r.why]).toEqual([roles(c.roles), c.main, c.why]); }
    for (const c of V.set_role) { const out = R.setRole(roles(c.roles)!, V.hw[c.hw], c.card, c.role); expect([out.roles, out.note]).toEqual([roles(c.after), c.note]); }
    for (const c of V.order) expect(R.order(roles(c.roles)!, V.hw[c.hw])).toEqual(c.gpu);
    for (const c of V.warnings) expect(R.warnings(roles(c.roles)!, V.hw[c.hw], { spillGb: c.spill_gb ?? 0 }).map(w => w.code)).toEqual(c.codes);
    for (const c of V.legacy) expect(R.fromLegacy(c.gpu, V.hw[c.hw], c.gpu_order)).toEqual(roles(c.roles));
  });
  it('reads saved roles the way serve/server.py does: a hand-edited "gpu" wins', () => {
    for (const c of V.saved) {
      const saved = R.savedRoles(c.cfg);
      expect(saved.roles).toEqual(c.roles === null ? null : roles(c.roles));
      if (c.problem === 'edited by hand') expect(saved.problem).toBe('edited');
      if (c.problem === 'ignored') expect(saved.problem).toBe('invalid');
    }
    expect(R.configGpuIds({ gpu_roles: { 0: 'helper', 1: 'main', 2: 'off' } })).toEqual([0, 1]);
    expect(R.configGpuIds({ gpu_roles: { 0: 'helper', 1: 'main' }, gpu: [1, 0] })).toEqual([1, 0]);
    expect(R.configGpuIds({ gpu: '2' })).toEqual([2]);
    expect(R.allCardsOff({ gpu_roles: { 0: 'off', 1: 'off' }, gpu: [], gpu_none: true })).toBe(true);
    expect(R.engineRunsWithoutCard({ backend: 'cuda' })).toBe(false);
    expect(R.engineRunsWithoutCard({ backend: 'metal' })).toBe(true);
    expect(R.engineRunsWithoutCard({}, true)).toBe(true);
  });
  it('writes roles with their legacy mirror and a layer split that fits', () => {
    const two = V.hw.two;
    const written = R.applyRoles({ args: [], gpu: 3, hip_ordinal: 1, layer_split: '16,32', api_key: 'kept' }, { 0: 'helper', 1: 'main' }, two);
    expect(written).toMatchObject({ gpu_roles: { 0: 'helper', 1: 'main' }, gpu: [0, 1], gpu_order: 'as_given', layer_split: 'auto', api_key: 'kept' });
    expect(written).not.toHaveProperty('hip_ordinal');
    expect(R.savedRoles(written)).toEqual({ roles: { 0: 'helper', 1: 'main' }, problem: null });
    expect(R.applyRoles({ layer_split: '18' }, { 0: 'helper', 1: 'main' }, two).layer_split).toBe('18');
    const off = R.applyRoles({ gpu_none: undefined }, { 0: 'off', 1: 'off' }, two);
    expect(off).toMatchObject({ gpu: [], gpu_none: true, gpu_roles: { 0: 'off', 1: 'off' } });
    const cleared = R.clearRoles(written);
    for (const key of ['gpu', 'gpu_order', 'gpu_roles', 'gpu_cards', 'gpu_none']) expect(cleared).not.toHaveProperty(key);
    expect(cleared.api_key).toBe('kept');
  });
  it('parses the setup.py --gpu-roles text', () => {
    expect(R.parseRolesText('1=main, 0:helper;2=off')).toEqual({ 0: 'helper', 1: 'main', 2: 'off' });
    for (const bad of ['', '1=boss', '1=main,1=helper', '0=main,1=main', '0=off', 'x=main', '1']) expect(R.parseRolesText(bad)).toBeNull();
    expect(R.rolesText({ 1: 'main', 0: 'helper' })).toBe('0=helper,1=main');
  });
  it('resource and concurrency assessments use the cards the roles turn on', () => {
    expect(readConcurrencySettings({ args: [], gpu_roles: { 0: 'helper', 1: 'off', 2: 'main' } }).gpuIds).toEqual([0, 2]);
    expect(readConcurrencySettings({ args: [], gpu_roles: { 0: 'helper', 1: 'main' }, gpu: [0, 1], gpu_order: 'as_given' }).gpuIds).toEqual([0, 1]);
    expect(readConcurrencySettings({ args: ['--gpu', '1'] }).gpuIds).toEqual([1]);
  });
  it('pool_cores is an optional advanced field validated like serve/server.py', () => {
    const field = STARTUP_TUNING_FIELDS.find(f => f.key === 'pool_cores')!;
    expect(field).toMatchObject({ target: 'config', group: 'cpu' });
    expect(applyStartupField({ args: [] }, field, '2-14:2').pool_cores).toBe('2-14:2');
    expect(applyStartupField({ args: [], pool_cores: '0,2' }, field, '')).not.toHaveProperty('pool_cores');
    for (const ok of ['0,2,4,6', ' 2-14:2 ', [2, 4, 6]]) expect(() => validateStartupConfiguration({ args: [], pool_cores: ok })).not.toThrow();
    for (const bad of ['abc', '1,,2', [-1], 'all']) expect(() => validateStartupConfiguration({ args: [], pool_cores: bad })).toThrow(/pool_cores/);
    expect(() => validateStartupConfiguration({ args: [], gpu_roles: { 0: 'main', 1: 'main' } })).toThrow(/gpu_roles/);
  });
});
