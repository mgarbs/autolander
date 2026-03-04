import { useEffect, useState } from 'react';
import { useRealtime as useRealtimeContext } from '../context/RealtimeContext';

export function useRealtimeEvent(eventType) {
  const { lastEvent } = useRealtimeContext();
  const [event, setEvent] = useState(null);

  useEffect(() => {
    if (lastEvent && lastEvent.type === eventType) {
      setEvent(lastEvent);
    }
  }, [lastEvent, eventType]);

  return event;
}
