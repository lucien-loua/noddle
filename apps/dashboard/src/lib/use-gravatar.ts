import { useEffect, useState } from "react";

async function sha256Hex(value: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    return null;
  }
  const bytes = new TextEncoder().encode(value);
  const digest = await subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function useGravatarUrl(email: string | null | undefined) {
  const [resolved, setResolved] = useState<{
    email: string;
    url: string | null;
  } | null>(null);

  useEffect(() => {
    if (!email) {
      return;
    }
    let cancelled = false;
    sha256Hex(email.trim().toLowerCase())
      .then((hash) => {
        if (!cancelled) {
          setResolved({
            email,
            url:
              hash === null
                ? null
                : `https://www.gravatar.com/avatar/${hash}?d=404`,
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResolved({ email, url: null });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [email]);

  return email && resolved?.email === email ? resolved.url : null;
}
