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
      heatGlobalAlpha: 1.0,
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

  test('α 越大衰减越快（同一 Δt 下 α=2 的热度低于 α=1）', () => {
    const now = Date.now();
    const base = {
      type: 'decision',
      last_accessed_at: now - 7 * 24 * HOUR,
    };

    const h1 = computeHeat(base, now, {
      heatTypeDecay: { decision: 0.002 },
      heatGlobalAlpha: 1.0,
    });

    const h2 = computeHeat(base, now, {
      heatTypeDecay: { decision: 0.002 },
      heatGlobalAlpha: 2.0,
    });

    assert(h2 < h1, 'α 更大时，同一 Δt 热度应更低');
  });

  test('buildHeatSignals 返回字段齐全且 deltaHours 正确', () => {
    const now = 1000000000000; // 固定毫秒时间戳
    const ref = now - 12 * HOUR;

    const signals = buildHeatSignals(
      { type: 'project', last_accessed_at: ref },
      { heatGlobalAlpha: 1.5 },
      now
    );

    assert.deepStrictEqual(Object.keys(signals).sort(), [
      'alpha',
      'deltaHours',
      'lambda',
      'ref',
      'type',
    ]);

    assert.strictEqual(signals.type, 'project');
    assert.strictEqual(signals.lambda, 0.0008);
    assert.strictEqual(signals.alpha, 1.5);
    assert.strictEqual(signals.ref, ref);
    assert.strictEqual(signals.deltaHours, 12);
  });
});