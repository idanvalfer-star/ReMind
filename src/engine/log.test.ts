import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/schema';
import { recordFire, recordResponse } from './log';

beforeEach(async () => {
  await db.open();
  await db.triggerFires.clear();
});

describe('recordFire', () => {
  it('logs a delivery as unanswered', async () => {
    const fire = await recordFire({ triggerId: 't1', deliveredVia: 'push', lookupFailed: false });

    expect(fire.response).toBe('none');
    expect(fire.respondedAt).toBeNull();
    expect(fire.lookupFailed).toBe(0);
    expect(await db.triggerFires.get(fire.id)).toEqual(fire);
  });

  it('records that the fallback text was shown', async () => {
    // Worth distinguishing: a spike in these means storage eviction, not user behaviour.
    const fire = await recordFire({ triggerId: 't1', deliveredVia: 'push', lookupFailed: true });
    expect(fire.lookupFailed).toBe(1);
  });
});

describe('recordResponse', () => {
  it('attaches a response to the outstanding delivery', async () => {
    const fire = await recordFire({
      triggerId: 't1',
      deliveredVia: 'push',
      lookupFailed: false,
      at: 1_000,
    });

    const updated = await recordResponse('t1', 'acted', 2_000);
    expect(updated).toMatchObject({ id: fire.id, response: 'acted', respondedAt: 2_000 });
    expect(await db.triggerFires.get(fire.id)).toMatchObject({ response: 'acted' });
  });

  it('answers the most recent delivery when a trigger has fired repeatedly', async () => {
    await recordFire({ triggerId: 't1', deliveredVia: 'push', lookupFailed: false, at: 1_000 });
    const second = await recordFire({
      triggerId: 't1',
      deliveredVia: 'push',
      lookupFailed: false,
      at: 5_000,
    });

    const updated = await recordResponse('t1', 'snoozed', 6_000);
    expect(updated?.id).toBe(second.id);
  });

  it('ignores deliveries that already have a response', async () => {
    const fire = await recordFire({
      triggerId: 't1',
      deliveredVia: 'push',
      lookupFailed: false,
      at: 1_000,
    });
    await recordResponse('t1', 'acted', 2_000);

    // A second click on the same notification must not overwrite the first answer.
    expect(await recordResponse('t1', 'dismissed', 3_000)).toBeUndefined();
    expect(await db.triggerFires.get(fire.id)).toMatchObject({
      response: 'acted',
      respondedAt: 2_000,
    });
  });

  it('returns undefined when there is nothing outstanding', async () => {
    expect(await recordResponse('never-fired', 'dismissed')).toBeUndefined();
  });

  it('keeps responses for different triggers apart', async () => {
    const a = await recordFire({ triggerId: 'ta', deliveredVia: 'push', lookupFailed: false });
    const b = await recordFire({ triggerId: 'tb', deliveredVia: 'push', lookupFailed: false });

    await recordResponse('ta', 'acted');

    expect(await db.triggerFires.get(a.id)).toMatchObject({ response: 'acted' });
    expect(await db.triggerFires.get(b.id)).toMatchObject({ response: 'none' });
  });
});
