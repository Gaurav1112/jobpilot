import type { z } from 'zod';

export interface MessageType<T = unknown> {
  readonly name: string;
  readonly version: number;
  /** `Name@version`, the routing key. */
  readonly id: string;
  readonly schema: z.ZodType<T>;
}

export function defineType<T>(name: string, version: number, schema: z.ZodType<T>): MessageType<T> {
  if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) throw new TypeError(`message type name must be PascalCase: ${name}`);
  if (!Number.isInteger(version) || version < 1) throw new TypeError(`message type version must be a positive integer: ${version}`);
  return Object.freeze({ name, version, id: `${name}@${version}`, schema });
}
