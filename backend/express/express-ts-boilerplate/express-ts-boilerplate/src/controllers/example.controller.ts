import type { Request, Response } from "express";
import { findExampleById, saveExample } from "../services/example.service";
import { NotFoundError } from "../utils/errors";

export const createExample = async (
  req: Request,
  res: Response,
): Promise<void> => {
  // req.body is already validated & typed by the validate() middleware.
  const created = await saveExample(req.body);
  res.status(201).json({ data: created });
};

export const getExample = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const { id } = req.params;

  if (typeof id !== "string") {
    throw new NotFoundError("A valid example id is required");
  }

  const found = await findExampleById(id);

  if (!found) {
    // Thrown here, caught by asyncHandler -> forwarded to the global handler,
    // which turns it into a clean 404 JSON response.
    throw new NotFoundError(`Example with id "${id}" not found`);
  }

  res.status(200).json({ data: found });
};
