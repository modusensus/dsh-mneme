import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateRegistryUrl,
  compareVersions,
  classify,
  fetchLatestVersion,
  resetCacheForTest,
  REGISTRY_URL,
  PACKAGE_VERSION,
} from '../src/version-check.js';

describe('version-check.js', () => {
  // ---- validateRegistryUrl：https + 精确 host 白名单（构造性排除本机/内网）----
  describe('validateRegistryUrl', () => {
    test('白名单内 https 地址通过', () => {
      assert.equal(validateRegistryUrl('https://registry.npmjs.org/@modusensus%2Fdsh-mneme/latest'), true);
      assert.equal(validateRegistryUrl('https://registry.npmjs.org/anything'), true);
    });

    test('非 https 一律拒绝', () => {
      assert.equal(validateRegistryUrl('http://registry.npmjs.org/latest'), false);
      assert.equal(validateRegistryUrl('ftp://registry.npmjs.org/latest'), false);
      assert.equal(validateRegistryUrl('file:///etc/passwd'), false);
    });

    test('host 不在白名单一律拒绝（含本机/内网/相似域名）', () => {
      assert.equal(validateRegistryUrl('https://localhost/latest'), false);
      assert.equal(validateRegistryUrl('https://127.0.0.1/latest'), false);
      assert.equal(validateRegistryUrl('https://[::1]/latest'), false);
      assert.equal(validateRegistryUrl('https://10.0.0.5/latest'), false);
      assert.equal(validateRegistryUrl('https://192.168.1.10/latest'), false);
      assert.equal(validateRegistryUrl('https://evil-registry.npmjs.org.example.com/latest'), false);
      assert.equal(validateRegistryUrl('https://registry.npmjs.org.evil.com/latest'), false);
      assert.equal(validateRegistryUrl('https://npmjs.org/latest'), false);
    });

    test('非法 URL 拒绝而不抛出', () => {
      assert.equal(validateRegistryUrl('not a url'), false);
      assert.equal(validateRegistryUrl(''), false);
    });
  });

  // ---- compareVersions / classify：纯函数比对 ----
  describe('compareVersions', () => {
    test('三元组数值比较', () => {
      assert.equal(compareVersions('0.8.0', '0.8.1'), -1);
      assert.equal(compareVersions('0.8.1', '0.8.0'), 1);
      assert.equal(compareVersions('0.8.0', '0.8.0'), 0);
      assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
      assert.equal(compareVersions('1.0.0', '0.9.9'), 1);
    });

    test('同号带 prerelease 的一方更旧；两侧都带视为同版', () => {
      assert.equal(compareVersions('0.9.0-rc.1', '0.9.0'), -1);
      assert.equal(compareVersions('0.9.0', '0.9.0-rc.1'), 1);
      assert.equal(compareVersions('0.9.0-rc.1', '0.9.0-rc.1'), 0);
      // 数字三元组相等、两侧都带后缀 → 同版（横幅只关心是否落后 latest，
      // 不追求完整 semver prerelease 序）
      assert.equal(compareVersions('0.9.0-rc.2', '0.9.0-rc.1'), 0);
    });

    test('解析失败返回 null', () => {
      assert.equal(compareVersions('unknown', '0.8.0'), null);
      assert.equal(compareVersions('0.8.0', ''), null);
      assert.equal(compareVersions(null, null), null);
    });
  });

  describe('classify', () => {
    test('四种形态', () => {
      assert.equal(classify('0.8.0', '0.8.1'), 'outdated');
      assert.equal(classify('0.8.0', '0.8.0'), 'up-to-date');
      // workspace/link 直载开发态：运行版本高于已发布 → ahead（前端不打扰）
      assert.equal(classify('0.9.0', '0.8.1'), 'ahead');
      // 查询失败/离线 → unknown（前端完全静默）
      assert.equal(classify('0.8.0', null), 'unknown');
      assert.equal(classify('unknown', '0.8.0'), 'unknown');
    });
  });

  // ---- fetchLatestVersion：TTL 缓存 + 失败静默 ----
  describe('fetchLatestVersion', () => {
    test('正常响应取 latest；TTL 内复用缓存不重复请求', async () => {
      resetCacheForTest();
      let calls = 0;
      let clock = 1000;
      const fetchImpl = async () => { calls += 1; return { ok: true, json: async () => ({ version: '0.8.1' }) }; };
      const now = () => clock;

      assert.equal(await fetchLatestVersion({ fetchImpl, now }), '0.8.1');
      assert.equal(await fetchLatestVersion({ fetchImpl, now }), '0.8.1');
      assert.equal(calls, 1);

      clock += 60 * 60 * 1000 - 1;
      assert.equal(await fetchLatestVersion({ fetchImpl, now }), '0.8.1');
      assert.equal(calls, 1);

      // 过 TTL 后重新请求
      clock += 1;
      assert.equal(await fetchLatestVersion({ fetchImpl, now }), '0.8.1');
      assert.equal(calls, 2);
      resetCacheForTest();
    });

    test('失败静默返回 null：网络异常 / 非 2xx / 形状不对', async () => {
      resetCacheForTest();
      assert.equal(await fetchLatestVersion({ fetchImpl: async () => { throw new Error('offline'); }, now: () => 1000 }), null);
      assert.equal(await fetchLatestVersion({ fetchImpl: async () => ({ ok: false, status: 503 }), now: () => 1000 }), null);
      assert.equal(await fetchLatestVersion({ fetchImpl: async () => ({ ok: true, json: async () => ({ nope: true }) }), now: () => 1000 }), null);
      resetCacheForTest();
    });

    test('失败不写缓存：下次调用立刻重试', async () => {
      resetCacheForTest();
      let calls = 0;
      let fail = true;
      const fetchImpl = async () => {
        calls += 1;
        if (fail) throw new Error('boom');
        return { ok: true, json: async () => ({ version: '0.8.2' }) };
      };
      assert.equal(await fetchLatestVersion({ fetchImpl, now: () => 1000 }), null);
      assert.equal(await fetchLatestVersion({ fetchImpl, now: () => 1000 }), null);
      assert.equal(calls, 2);
      fail = false;
      assert.equal(await fetchLatestVersion({ fetchImpl, now: () => 1000 }), '0.8.2');
      resetCacheForTest();
    });

    test('运行环境无全局 fetch 时走默认参兜底：resolve null 而非同步抛', async () => {
      resetCacheForTest();
      const original = globalThis.fetch;
      globalThis.fetch = undefined;
      try {
        // 修复前：默认参 fetchImpl = fetch 在参数求值期同步抛 ReferenceError，
        // 路由的 .catch 接不住；修复后应归入常规失败路径静默返 null。
        assert.equal(await fetchLatestVersion({ now: () => 1000 }), null);
      } finally {
        globalThis.fetch = original;
      }
      resetCacheForTest();
    });
  });

  // ---- 模块常量：URL 必须过白名单，运行版本可读 ----
  test('REGISTRY_URL 自身通过白名单校验；PACKAGE_VERSION 可读', () => {
    assert.equal(validateRegistryUrl(REGISTRY_URL), true);
    assert.match(PACKAGE_VERSION, /^\d+\.\d+\.\d+/);
  });
});
