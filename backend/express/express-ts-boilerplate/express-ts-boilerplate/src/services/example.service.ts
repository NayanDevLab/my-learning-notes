import { randomUUID } from "node:crypto";

/**
 * Demo service using an in-memory store. Replace this with real database
 * calls (Prisma, Mongoose, Drizzle, raw SQL, ...) in your projects.
 */
export interface Example {
  id: string;
  name: string;
  email: string;
}

const store = new Map<string, Example>();

export const saveExample = async (
  input: Omit<Example, "id">,
): Promise<Example> => {
  const example: Example = { id: randomUUID(), ...input };
  store.set(example.id, example);
  return example;
};

export const findExampleById = async (
  id: string,
): Promise<Example | null> => {
  return store.get(id) ?? null;
};
