// Who a login belongs to (which business, boss or staff), what each role may do, and the members / invites routes.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { accounts, invites, parties, items, entries, ensureAccount, fail } from './db';

export const MAX_MEMBERS = 256; // everyone ever added, the boss included
const INVITE_DAYS = 7;

export type Role = 'boss' | 'staff';
/** Who is doing this, taken from the verified token, never from the request body. */
export interface Who { tenantId: string; userId: string; role: Role; deviceId: string }
export const who = (req: FastifyRequest): Who => ({ tenantId: req.tenantId, userId: req.userId, role: req.role, deviceId: req.deviceId });

/** Which business is this login in, and as what? A brand-new login gets a business of its own, as boss. */
export async function resolveAccount(sub: string, name: string): Promise<{ tenantId: string; role: Role }> {
  const find = () => accounts().findOne({ members: { $elemMatch: { sub, removed: { $ne: true } } } });
  let a = await find();
  if (!a) {
    if (await accounts().findOne({ 'members.sub': sub })) fail(403, 'revoked', 'you were removed from this business');
    await ensureAccount(sub, name);
    a = await find();
  }
  return { tenantId: a!._id, role: a!.members.find((m) => m.sub === sub)!.role };
}

/** The whole rulebook for staff. The boss can do everything. */
export type Action = 'delete_entry' | 'remove_party' | 'remove_item' | 'manage';
export function can(w: Who, action: Action, record?: { createdBy?: string }): boolean {
  if (w.role === 'boss') return true;
  return action === 'delete_entry' && record?.createdBy === w.userId; // staff may delete only what they recorded
}
export function need(w: Who, action: Action, record?: { createdBy?: string }) {
  if (!can(w, action, record)) fail(403, 'not_allowed', 'only the boss can do that');
}

/** Business name and members, for /api/me and sync. Removed members stay listed so old history still shows their name. */
export async function accountInfo(tenantId: string) {
  const a = await accounts().findOne({ _id: tenantId });
  return { name: a?.name ?? '', members: (a?.members ?? []).map((m) => ({ id: m.sub, name: m.name, role: m.role, removed: !!m.removed })) };
}

export function accountRoutes(app: FastifyInstance) {
  app.get('/api/me', async (req) => ({ id: req.userId, accountId: req.tenantId, role: req.role, ...(await accountInfo(req.tenantId)), serverTime: new Date() }));

  app.post('/api/account', async (req) => { // rename the business
    need(who(req), 'manage');
    const { name } = z.object({ name: z.string().trim().min(1).max(100) }).parse(req.body);
    await accounts().updateOne({ _id: req.tenantId }, { $set: { name } });
    return { name };
  });

  app.post('/api/invites', async (req) => {
    need(who(req), 'manage');
    const code = randomBytes(8).toString('hex');
    const expiresAt = new Date(Date.now() + INVITE_DAYS * 86_400_000);
    await invites().insertOne({ _id: code, accountId: req.tenantId, expiresAt });
    return { code, expiresAt };
  });

  // A new staff member signs in (which gives them an empty business of their own), then joins with the code.
  // They can only join if that empty business really is empty, so no one's books are ever swallowed.
  app.post('/api/invites/accept', async (req) => {
    const { code, name } = z.object({ code: z.string().min(1).max(64), name: z.string().trim().min(1).max(100).default('Staff') }).parse(req.body);
    const mine = await accounts().findOne({ _id: req.tenantId });
    const busy = !mine || mine.members.length !== 1 || mine.members[0].sub !== req.userId
      || (await Promise.all([parties(), items(), entries()].map((c) => (c as any).countDocuments({ tenantId: req.tenantId })))).some((n) => n > 0);
    if (busy) fail(409, 'account_in_use', 'this login already has a business');

    const invite = await invites().findOneAndUpdate({ _id: code, usedBy: { $exists: false }, expiresAt: { $gt: new Date() } }, { $set: { usedBy: req.userId } });
    if (!invite) fail(404, 'invite_invalid', 'this invite is wrong, used or expired');
    // The slot check and the add are one step, so two people can never take the last slot together.
    const joined = await accounts().updateOne({ _id: invite.accountId, [`members.${MAX_MEMBERS - 1}`]: { $exists: false } }, { $push: { members: { sub: req.userId, role: 'staff', name } } });
    if (!joined.matchedCount) {
      await invites().updateOne({ _id: code }, { $unset: { usedBy: '' } });
      fail(409, 'member_limit', `a business can have at most ${MAX_MEMBERS} members`);
    }
    await accounts().deleteOne({ _id: req.tenantId });
    return { accountId: invite.accountId, role: 'staff' };
  });

  app.delete('/api/members/:id', async (req) => { // revoke: their next request is refused and their phone wipes itself
    need(who(req), 'manage');
    const { id } = z.object({ id: z.string().min(1).max(200) }).parse(req.params);
    if (id === req.tenantId) fail(400, 'cannot_remove_boss', 'the boss cannot be removed');
    const r = await accounts().updateOne({ _id: req.tenantId, 'members.sub': id }, { $set: { 'members.$.removed': true } });
    if (!r.matchedCount) fail(404, 'not_found');
    return { id, removed: true };
  });
}
