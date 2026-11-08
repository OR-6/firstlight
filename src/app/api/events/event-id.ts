import { z } from 'zod';

/** A USGS / replay event id such as "us6000u18k". Unknown but well-formed ids are a 404 later. */
export const EventId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'must be an event id like "us6000u18k" (letters, digits, - or _)');
