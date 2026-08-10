ALTER TABLE "databases" ADD COLUMN "cpu_limit_nanos" bigint;--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN "memory_limit_bytes" bigint;--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN "memory_reservation_bytes" bigint;