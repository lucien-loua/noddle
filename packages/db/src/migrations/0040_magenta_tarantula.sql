ALTER TABLE "server_metrics" ADD COLUMN "block_read_bytes" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "server_metrics" ADD COLUMN "block_write_bytes" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "server_metrics" ADD COLUMN "network_in_bytes" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "server_metrics" ADD COLUMN "network_out_bytes" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "service_metrics" ADD COLUMN "block_read_bytes" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "service_metrics" ADD COLUMN "block_write_bytes" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "service_metrics" ADD COLUMN "network_in_bytes" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "service_metrics" ADD COLUMN "network_out_bytes" bigint NOT NULL;