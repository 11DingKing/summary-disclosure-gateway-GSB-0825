import { Prisma, type PrismaClient } from "@prisma/client";

export type TransactionClient = Prisma.TransactionClient;

/**
 * Run a create operation behind an idempotency key.
 *
 * - If no key is supplied the create runs normally.
 * - If a key is supplied and a prior record exists for (key, endpoint), the
 *   stored response is replayed.
 * - If two requests race on the same key, the loser's transaction is rolled
 *   back by the primary-key constraint and the winner's stored response is
 *   returned.
 */
export async function idempotentCreate<T>(
  prisma: PrismaClient,
  key: string | undefined,
  endpoint: string,
  create: (tx: TransactionClient) => Promise<{ id: string; response: T }>,
): Promise<{ response: T; replayed: boolean }> {
  if (!key) {
    const response = await prisma.$transaction(async (tx) => {
      const { response } = await create(tx);
      return response;
    });
    return { response, replayed: false };
  }

  const existing = await prisma.idempotencyRecord.findUnique({
    where: { key_endpoint: { key, endpoint } },
  });
  if (existing) {
    return { response: JSON.parse(existing.response) as T, replayed: true };
  }

  try {
    const response = await prisma.$transaction(async (tx) => {
      const { id, response } = await create(tx);
      await tx.idempotencyRecord.create({
        data: {
          key,
          endpoint,
          resourceId: id,
          response: JSON.stringify(response),
        },
      });
      return response;
    });
    return { response, replayed: false };
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const winner = await prisma.idempotencyRecord.findUnique({
        where: { key_endpoint: { key, endpoint } },
      });
      if (winner) {
        return { response: JSON.parse(winner.response) as T, replayed: true };
      }
    }
    throw err;
  }
}
