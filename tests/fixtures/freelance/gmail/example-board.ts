import type { AlertJob, AlertParser } from '../../../../src/app/freelance/mail/parsers/index.js';

/**
 * A FICTIONAL alert parser, for tests only: "Example Board" does not exist and `example-board.test` is a reserved test
 * domain. It is never registered in `ALERT_PARSERS` (src/app/freelance/mail/parsers/index.ts); real parsers are built
 * there, one per real sample email the user provides. Its sample is `example-board.eml` beside this file.
 *
 * Layout: a heading line (the fingerprint), then blocks `--- JOB <n> ---` numbered from 1, each with `Title:` and
 * `Link:` lines and optional `Company:`, `Pay:`, `Location:`, `Summary:` lines. Anything else throws, so the whole
 * message is quarantined, never half read.
 */
export const EXAMPLE_SENDER = 'alerts@example-board.test';
export const EXAMPLE_FINGERPRINT = 'Example Board · contract alerts digest';

const FIELD = /^(Title|Company|Pay|Location|Link|Summary): (.*)$/;

export const exampleBoardParser: AlertParser = {
  id: 'example-board',
  sender: EXAMPLE_SENDER,
  fingerprint: EXAMPLE_FINGERPRINT,
  parse(mail) {
    if (mail.text === null) throw new Error('no text part');
    const parts = mail.text.split(/^--- JOB (\d+) ---$/m);
    const jobs: AlertJob[] = [];
    for (let i = 1; i < parts.length; i += 2) {
      if (Number(parts[i]) !== jobs.length + 1) throw new Error('job blocks out of order');
      const fields = new Map<string, string>();
      for (const line of (parts[i + 1] ?? '').split('\n')) {
        const m = FIELD.exec(line.trim());
        if (m !== null) fields.set(m[1] as string, (m[2] as string).trim());
      }
      const title = fields.get('Title');
      const url = fields.get('Link');
      if (title === undefined || url === undefined || !url.startsWith('https://jobs.example-board.test/')) throw new Error('a job block lacks its title or link');
      const pay = fields.get('Pay');
      jobs.push({
        title,
        url,
        description: fields.get('Summary') ?? '',
        company: fields.get('Company') ?? null,
        location: fields.get('Location') ?? null,
        pay: pay === undefined || pay === 'not stated' ? null : pay,
        postedAt: null,
        kind: 'contract',
      });
    }
    return jobs;
  },
};
