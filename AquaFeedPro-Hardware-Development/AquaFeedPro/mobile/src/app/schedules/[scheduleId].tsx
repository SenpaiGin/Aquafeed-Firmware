import { useLocalSearchParams } from "expo-router";

import { ScheduleEditor } from "@/components/schedule-editor";

export default function ScheduleDetailsScreen() {
  const { scheduleId } = useLocalSearchParams<{ scheduleId: string }>();
  return (
    <ScheduleEditor
      scheduleId={Array.isArray(scheduleId) ? scheduleId[0] : scheduleId}
    />
  );
}
