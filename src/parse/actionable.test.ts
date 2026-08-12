import { describe, expect, it } from 'vitest';
import { detectActionable } from './actionable';

/**
 * Precision over recall, deliberately. A missed offer costs one tap; a wrong offer puts a
 * "make this a reminder" button on a note that is not a task, and after a few of those nobody
 * reads the offers any more. The negative cases below are as much the specification as the
 * positive ones.
 */

describe('detectActionable — English', () => {
  it('recognises an explicit request', () => {
    for (const text of [
      'Remind me to call the dentist',
      "Don't forget to pay the electricity bill",
      'Dont forget the milk',
      'Remember to water the plants',
      'I need to renew my passport',
      'Have to send the form',
    ]) {
      expect(detectActionable(text, 'en'), text).toMatchObject({
        isActionable: true,
        marker: 'explicit',
      });
    }
  });

  it('recognises an imperative verb at the start', () => {
    for (const text of ['Call Dani', 'Buy milk', 'Pick up the parcel', 'Book the flights']) {
      expect(detectActionable(text, 'en'), text).toMatchObject({
        isActionable: true,
        marker: 'imperative-verb',
      });
    }
  });

  it('does not treat a past-tense note as a task', () => {
    // The verb is only imperative at the start; position is the whole signal.
    for (const text of [
      'I bought milk today',
      'Dani called about the project',
      'We booked the flights already',
      'The call went well',
    ]) {
      expect(detectActionable(text, 'en').isActionable, text).toBe(false);
    }
  });

  it('does not treat an ordinary observation as a task', () => {
    for (const text of [
      "Alex prefers oat milk",
      'The vase in the window was 200 shekels',
      "Sarah's kid is called Noam",
      '',
      '   ',
    ]) {
      expect(detectActionable(text, 'en').isActionable, JSON.stringify(text)).toBe(false);
    }
  });
});

describe('detectActionable — Hebrew', () => {
  it('recognises an explicit request', () => {
    for (const text of [
      'תזכיר לי להתקשר לרופא שיניים',
      'אל תשכח לשלם את החשמל',
      'לא לשכוח חלב',
      'צריך להזמין כרטיסים',
      'חייב לסיים את הדוח',
    ]) {
      expect(detectActionable(text, 'he'), text).toMatchObject({
        isActionable: true,
        marker: 'explicit',
      });
    }
  });

  it('recognises an infinitive at the start, which is how tasks are written', () => {
    for (const text of ['להתקשר לדני', 'לקנות חלב', 'לשלוח את הטופס', 'לבדוק את המחיר']) {
      expect(detectActionable(text, 'he'), text).toMatchObject({
        isActionable: true,
        marker: 'infinitive',
      });
    }
  });

  it('does not treat a note as a task', () => {
    for (const text of [
      'דני התקשר בנוגע לפרויקט', // Dani called about the project
      'אלכס מעדיף חלב שיבולת שועל', // Alex prefers oat milk
      'האגרטל בחלון עלה 200 שקל', // the vase in the window cost 200
    ]) {
      expect(detectActionable(text, 'he').isActionable, text).toBe(false);
    }
  });

  it('does not fire on a short leading lamed word', () => {
    // The length floor keeps "lo" and similar function words out.
    expect(detectActionable('לא נורא', 'he').isActionable).toBe(false);
  });
});
