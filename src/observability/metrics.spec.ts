import { describe, expect, it } from 'vitest';

import { MetricsRegistry } from './metrics.js';

describe('MetricsRegistry', () => {
  it('renderiza counters com labels no formato Prometheus', async () => {
    const registry = new MetricsRegistry();
    const counter = registry.counter('wager_transactions_total', 'Transações.');

    counter.inc({ operation: 'BET', status: 'PROCESSED' });
    counter.inc({ status: 'PROCESSED', operation: 'BET' }, 2); // ordem das labels não importa
    counter.inc({ operation: 'BET', status: 'REJECTED' });

    const text = await registry.render();

    expect(text).toContain('# TYPE wager_transactions_total counter');
    expect(text).toContain('wager_transactions_total{operation="BET",status="PROCESSED"} 3');
    expect(text).toContain('wager_transactions_total{operation="BET",status="REJECTED"} 1');
  });

  it('histograma acumula buckets, soma e contagem', async () => {
    const registry = new MetricsRegistry();
    const histogram = registry.histogram('latency_seconds', 'Latência.', [0.1, 1]);

    histogram.observe({ route: '/x' }, 0.05);
    histogram.observe({ route: '/x' }, 0.5);
    histogram.observe({ route: '/x' }, 5);

    const text = await registry.render();

    expect(text).toContain('latency_seconds_bucket{route="/x",le="0.1"} 1');
    expect(text).toContain('latency_seconds_bucket{route="/x",le="1"} 2');
    expect(text).toContain('latency_seconds_bucket{route="/x",le="+Inf"} 3');
    expect(text).toContain('latency_seconds_sum{route="/x"} 5.55');
    expect(text).toContain('latency_seconds_count{route="/x"} 3');
  });

  it('executa collectors antes de renderizar e tolera falhas', async () => {
    const registry = new MetricsRegistry();
    const gauge = registry.gauge('outbox_events', 'Outbox.');

    registry.addCollector(() => gauge.set({ status: 'PENDING' }, 7));
    registry.addCollector(() => {
      throw new Error('db down');
    });

    expect(await registry.render()).toContain('outbox_events{status="PENDING"} 7');
  });

  it('escapa valores de label', async () => {
    const registry = new MetricsRegistry();
    registry.counter('c_total', 'c').inc({ path: 'a"b\\c\nd' });
    expect(await registry.render()).toContain('c_total{path="a\\"b\\\\c\\nd"} 1');
  });

  it('rejeita nomes inválidos, duplicados e decremento de counter', () => {
    const registry = new MetricsRegistry();
    expect(() => registry.counter('bad-name', 'x')).toThrow();
    registry.counter('ok_total', 'x');
    expect(() => registry.counter('ok_total', 'x')).toThrow();
    expect(() => registry.counter('other_total', 'x').inc({}, -1)).toThrow();
  });
});
