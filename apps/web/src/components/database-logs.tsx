import { useEffect, useState } from "react";
import { LogView, usePlainBlocks } from "@/components/log-view";

interface DatabaseLogsProps {
  databaseId: string;
  databaseName: string;
}

export function DatabaseLogs({ databaseId, databaseName }: DatabaseLogsProps) {
  const [text, setText] = useState("");
  const [live, setLive] = useState(true);

  useEffect(() => {
    setText("");
    setLive(true);

    const source = new EventSource(`/api/database-logs/${databaseId}`);

    source.addEventListener("chunk", (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as {
        data: string;
      };
      setText((previous) => previous + payload.data);
    });

    // Tailing stops when the container stops. We close the source at that
    // point rather than letting EventSource reconnect in a loop against a
    // stopped database — the badge says "stopped" and the log stays
    // readable.
    source.addEventListener("end", () => {
      setLive(false);
      source.close();
    });

    source.onerror = () => {
      setLive(false);
    };

    return () => source.close();
  }, [databaseId]);

  const blocks = usePlainBlocks(text);

  return (
    <LogView
      blocks={blocks}
      idleLabel="stopped"
      live={live}
      placeholder={`Waiting for ${databaseName} to say something…`}
      title="Container logs"
    />
  );
}
