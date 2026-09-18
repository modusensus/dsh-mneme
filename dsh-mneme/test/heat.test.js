import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeHeat,
  buildHeatSignals,
  TYPE_DECAY_DEFAULTS,
} from '../src/heat.js';

const HOUR = 3600000;

describe('heat.js', () => {
  test('未知类型使用默认 λ=0.002；72h 后 heat < 1 且 > 0.8，并随 Δt 单调递减', () => {
    const now = Date.now();
    const base = { type: 'episodic', last_accessed_at: now - 72 * HOUR };

    const heat72 = computeHeat(base, now, {});
    const heat144 = computeHeat(
      { ...base, last_accessed_at: now - 144 * HOUR },
      now,
      {}
    );

    assert(heat72 < 1.0, '72h 后热度应小于 1');
    assert(heat72 > 0.8, '72h 后热度应仍大于 0.8');
    assert(heat144 < heat72, 'Δt 越大，热度应越低');
  });

  test('λ=0 的免疫类型任意 Δt 返回 1.0', () => {
    const now = Date.now();
    const config = { heatTypeDecay: { preference: 0 } };

    assert.strictEqual(
      computeHeat(
        { type: 'preference', last_accessed_at: now - 999 * 24 * HOUR },
        now,
        config
      ),
      1.0
    );

    assert.strictEqual(
      computeHeat(
        { type: 'pattern', last_accessed_at: now - 365 * 24 * HOUR },
        now,
        { heatTypeDecay: TYPE_DECAY_DEFAULTS }
      ),
      1.0
    );
  });

  test('ref 优先使用 last_accessed_at，缺失退 created_at，皆无返回 1.0', () => {
    const now = Date.now();
    const config = {
      heatTypeDecay: { decision: 0.002 },
      heatGlobalBeta: 1.0,
    };

    const withLast = computeHeat(
      {
        type: 'decision',
        last_accessed_at: now - 24 * HOUR,
        created_at: now - 100 * HOUR,
      },
      now,
      config
    );

    const withCreated = computeHeat(
      { type: 'decision', created_at: now - 24 * HOUR },
      now,
      config
    );

    assert(withLast < 1.0);
    assert.strictEqual(withLast, withCreated);

    const noRef = computeHeat({ type: 'decision' }, now, config);
    assert.strictEqual(noRef, 1.0);
  });

  test('非法 ref 或 now < ref 时返回 1.0', () => {
    const now = Date.now();

    assert.strictEqual(
      computeHeat(
        { type: 'decision', last_accessed_at: 'not-a-date' },
        now,
        {}
      ),
      1.0
    );

    assert.strictEqual(
      computeHeat(
        { type: 'decision', last_accessed_at: now + 1000 },
        now,
        {}
      ),
      1.0
    );
  });

  test('β 越大衰减越快（同一 Δt 下 β=2 的热度低于 β=1）', () => {
    const now = Date.now();
    const base = {
      type: 'decision',
      last_accessed_at: now - 7 * 24 * HOUR,
    };

    const h1 = computeHeat(base, now, {
      heatTypeDecay: { decision: 0.002 },
      heatGlobalBeta: 1.0,
    });

    const h2 = computeHeat(base, now, {
      heatTypeDecay: { decision: 0.002 },
      heatGlobalBeta: 2.0,
    });

    assert(h2 < h1, 'β 更大时，同一 Δt 热度应更低');
  });

  test('β=1 退化为纯指数：H=exp(-λΔt)（精确值锚定）', () => {
    const now = Date.now();
    const heat = computeHeat(
      { type: 'decision', last_accessed_at: now - 100 * HOUR },
      now,
      { heatTypeDecay: { decision: 0.002 }, heatGlobalBeta: 1.0 }
    );
    assert.ok(Math.abs(heat - Math.exp(-0.2)) < 1e-12, 'λ=0.002、Δt=100h、β=1 → exp(-0.2)');
  });

  test('β 管形状：同 Δt（>1h）下 β=0.5 的亚线性长尾热度高于 β=2', () => {
    const now = Date.now();
    const base = { type: 'decision', last_accessed_at: now - 24 * HOUR };
    const slow = computeHeat(base, now, { heatTypeDecay: { decision: 0.002 }, heatGlobalBeta: 0.5 });
    const fast = computeHeat(base, now, { heatTypeDecay: { decision: 0.002 }, heatGlobalBeta: 2.0 });
    assert.ok(slow > fast, 'β 越小长尾越厚');
  });

  test('touch 回温：last_accessed_at 刷新后热度回到满格', () => {
    const now = Date.now();
    const config = { heatTypeDecay: { decision: 0.002 } };
    const cold = computeHeat({ type: 'decision', last_accessed_at: now - 500 * HOUR }, now, config);
    const rewarmed = computeHeat({ type: 'decision', last_accessed_at: now - 1 }, now, config);
    assert.ok(cold < 0.5, '500h 未访问已显著降温');
    assert.ok(rewarmed > 0.999, '刚触达即回满');
  });

  test('buildHeatSignals 返回字段齐全且 deltaHours 正确', () => {
    const now = 1000000000000; // 固定毫秒时间戳
    const ref = now - 12 * HOUR;

    const signals = buildHeatSignals(
      { type: 'project', last_accessed_at: ref },
      { heatGlobalBeta: 1.5 },
      now
    );

    assert.deepStrictEqual(Object.keys(signals).sort(), [
      'beta',
      'deltaHours',
      'lambda',
      'ref',
      'type',
    ]);

    assert.strictEqual(signals.type, 'project');
    assert.strictEqual(signals.lambda, 0.0008);
    assert.strictEqual(signals.beta, 1.5);
    assert.strictEqual(signals.ref, ref);
    assert.strictEqual(signals.deltaHours, 12);
  });
});
