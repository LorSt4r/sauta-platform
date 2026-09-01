-- Allinea il DB allo schema Prisma dopo la rimozione di relay/ws:
-- lo schema non conosce più venues.fiscal_mode né le tabelle relay-era.
-- IF EXISTS rende la migrazione sicura anche su DB già allineati.
ALTER TABLE "venues" DROP COLUMN IF EXISTS "fiscal_mode";

DROP TABLE IF EXISTS "pending_print_jobs";
DROP TABLE IF EXISTS "edge_relays";
