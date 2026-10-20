import { supabase } from "@/lib/supabase";

/** Calls onChange (debounced 250 ms) when any of the tables changes for this feeder. Returns the cleanup. */
export function subscribeDeviceChanges(
  name: string,
  deviceId: string,
  tables: readonly string[],
  onChange: () => void,
): () => void {
  let active = true;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (!active) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = undefined;
      if (active) onChange();
    }, 250);
  };
  const channel = tables
    .reduce(
      (current, table) =>
        current.on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table,
            filter: "device_id=eq." + deviceId,
          },
          schedule,
        ),
      supabase.channel(name + "-" + deviceId),
    )
    .subscribe();

  return () => {
    active = false;
    if (debounce) clearTimeout(debounce);
    void supabase.removeChannel(channel);
  };
}
