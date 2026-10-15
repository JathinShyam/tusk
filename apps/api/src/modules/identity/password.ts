import { hash, verify } from "@node-rs/argon2";

/** Argon2id parameters per OWASP password storage cheat sheet (19 MiB, t=2, p=1). */
const ARGON2_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(
  hashed: string,
  password: string,
): Promise<boolean> {
  try {
    return await verify(hashed, password, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | null = null;

/**
 * Run a verification even when the email does not exist so response timing
 * does not reveal whether an account exists. TR-SEC-001.
 */
export async function equalizeLoginTiming(password: string): Promise<void> {
  dummyHash ??= hashPassword("tusk-login-timing-equalizer");
  await verifyPassword(await dummyHash, password);
}
