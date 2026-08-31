#property strict
#property version   "1.0"
#property description "XAUUSD MT5 tick-flow exporter for Gold-alert-bot. Does not trade."

input string InpSymbol = "XAUUSD";
input int    InpWindowSeconds = 60;
input int    InpTimerSeconds = 5;
input string InpBridgeURL = "";
input string InpApiKey = "";

string FileName = "orderflow.json";
datetime last_sample = 0;

string JsonEscape(string s)
{
   StringReplace(s, "\\", "\\\\");
   StringReplace(s, "\"", "\\\"");
   return s;
}

bool GetFlow(double &buy_volume, double &sell_volume, long &ticks)
{
   datetime to = TimeCurrent();
   datetime from = to - MathMax(10, InpWindowSeconds);
   MqlTick t[];
   ulong from_msc = (ulong)from * 1000;
   ulong to_msc   = (ulong)to * 1000 + 999;
   int n = CopyTicksRange(InpSymbol, t, COPY_TICKS_TRADE, from_msc, to_msc);
   if(n <= 0)
   {
      n = CopyTicksRange(InpSymbol, t, COPY_TICKS_INFO, from_msc, to_msc);
      if(n <= 0) return false;
   }

   buy_volume = 0.0;
   sell_volume = 0.0;
   ticks = n;

   for(int i=0; i<n; i++)
   {
      double v = (t[i].volume_real > 0.0 ? t[i].volume_real : (double)t[i].volume);
      if((t[i].flags & TICK_FLAG_BUY) != 0) buy_volume += v;
      if((t[i].flags & TICK_FLAG_SELL) != 0) sell_volume += v;
   }
   return (buy_volume > 0.0 || sell_volume > 0.0);
}

string BuildJson(double buy_volume, double sell_volume, long ticks)
{
   double delta = buy_volume - sell_volume;
   double total = buy_volume + sell_volume;
   double imbalance = (total > 0.0 ? delta / total : 0.0);
   string label = "NEUTRAL";
   if(imbalance > 0.20) label = "BUY";
   else if(imbalance < -0.20) label = "SELL";

   MqlTick last_tick;
   double price = 0.0;
   if(SymbolInfoTick(InpSymbol, last_tick))
      price = (last_tick.bid > 0.0 ? last_tick.bid : last_tick.last);

   string time_iso = TimeToString(TimeCurrent(), TIME_DATE|TIME_SECONDS);
   StringReplace(time_iso, ".", "-");
   StringReplace(time_iso, " ", "T");

   return StringFormat(
      "{\"symbol\":\"%s\",\"time\":\"%sZ\",\"source\":\"MT5-TICKS\",\"isReal\":true,\"delta\":%.8f,\"cvdSlope\":%.8f,\"imbalance\":\"%s\",\"buyVolume\":%.8f,\"sellVolume\":%.8f,\"ticks\":%I64d,\"price\":%.5f,\"windowSeconds\":%d}",
      JsonEscape(InpSymbol), time_iso, delta, delta, label,
      buy_volume, sell_volume, ticks, price, InpWindowSeconds);
}

bool WriteCommonFile(string payload)
{
   int h = FileOpen(FileName, FILE_WRITE|FILE_TXT|FILE_COMMON|FILE_ANSI);
   if(h == INVALID_HANDLE)
   {
      Print("ORDERFLOW: FileOpen failed. Error=", GetLastError());
      return false;
   }
   FileWriteString(h, payload);
   FileClose(h);
   return true;
}

bool PostBridge(string payload)
{
   if(StringLen(InpBridgeURL) == 0) return true;

   string headers = "Content-Type: application/json\r\n";
   if(StringLen(InpApiKey) > 0)
      headers += "X-API-Key: " + InpApiKey + "\r\n";

   char data[];
   char result[];
   string result_headers;
   StringToCharArray(payload, data, 0, StringLen(payload), CP_UTF8);
   ResetLastError();
   int code = WebRequest("POST", InpBridgeURL, headers, 5000, data, ArraySize(data), result, result_headers);
   if(code < 0)
   {
      Print("ORDERFLOW: WebRequest failed. Error=", GetLastError());
      return false;
   }
   if(code < 200 || code >= 300)
   {
      Print("ORDERFLOW: Bridge HTTP ", code);
      return false;
   }
   return true;
}

void Sample()
{
   double buy_volume, sell_volume;
   long ticks;
   if(!GetFlow(buy_volume, sell_volume, ticks))
   {
      Print("ORDERFLOW: no usable MT5 tick flow yet");
      return;
   }

   string payload = BuildJson(buy_volume, sell_volume, ticks);
   bool file_ok = WriteCommonFile(payload);
   bool bridge_ok = PostBridge(payload);

   double delta = buy_volume - sell_volume;
   PrintFormat("ORDERFLOW: %s delta=%.4f buy=%.4f sell=%.4f ticks=%I64d file=%s bridge=%s",
               InpSymbol, delta, buy_volume, sell_volume, ticks,
               file_ok ? "OK" : "FAIL", bridge_ok ? "OK" : "OFF/FAIL");
}

int OnInit()
{
   if(!SymbolSelect(InpSymbol, true))
   {
      Print("ORDERFLOW: cannot select symbol ", InpSymbol);
      return INIT_FAILED;
   }
   EventSetTimer(MathMax(1, InpTimerSeconds));
   Print("ORDERFLOW: exporter started. This EA DOES NOT trade.");
   Sample();
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   Print("ORDERFLOW: exporter stopped. reason=", reason);
}

void OnTimer()
{
   Sample();
}

void OnTick()
{
   // Timer-driven exporter; no trading logic here.
}
