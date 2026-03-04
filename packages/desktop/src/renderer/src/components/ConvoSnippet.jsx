export default function ConvoSnippet({ messages = [], limit = 10 }) {
  const shown = messages.slice(-limit);

  if (shown.length === 0) {
    return <p className="text-slate-500 text-sm italic">No messages recorded</p>;
  }

  return (
    <div className="space-y-2 max-h-96 overflow-y-auto">
      {shown.map((msg, i) => {
        const isIncoming = msg.direction === 'incoming';
        return (
          <div
            key={i}
            className={`flex ${isIncoming ? 'justify-start' : 'justify-end'}`}
          >
            <div className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${
              isIncoming
                ? 'bg-slate-700 text-slate-200'
                : 'bg-blue-600 text-white'
            }`}>
              <p>{msg.text || msg.message}</p>
              {msg.timestamp && (
                <p className={`text-xs mt-1 ${isIncoming ? 'text-slate-400' : 'text-blue-200'}`}>
                  {new Date(msg.timestamp || msg.receivedAt).toLocaleTimeString()}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
