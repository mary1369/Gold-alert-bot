//+------------------------------------------------------------------+
//| GoldOrderFlowBridge.mq5                                          |
//| Free MT5 -> HTTP Order Flow bridge for Gold-alert-bot            |
//| Uses broker tick feed. It is NOT global XAUUSD order flow.       |
//+------------------------------------------------------------------+
#property strict
#property version "1.0"

input string InpSymbol = "XAUUSD";
input string InpEndpoint = ""; // Example: https://YOUR-SERVER/orderflow
input string InpApiKey = "";   // Optional shared secret
input int    InpSeconds = 2;
input int    InpMaxTicks = 5000;
input double InpImbalanceThreshold = 2.0;

long   g_last_msc = 0;
double g_cvd = 0.0;

string JsonEscape(string s)
{
   StringReplace(s, "\\", "\\\\");
   StringReplace(s, "\"", "\\\"");
   return s;
}

bool IsBuy(const MqlTick &t)
{
   return ((t.flags & TICK_FLAG_BUY) == TICK_FLAG_BUY);
}

bool IsSell(const MqlTick &t)
{
   return ((t.flags & TICK_FLAG_SELL) == TICK_FLAG_SELL);
}

int OnInit()
{
   if(InpEndpoint == "")
   {
      Print("Order Flow bridge disabled: InpEndpoint is empty.");
      return(INIT_SUCCEEDED);
   }
   EventSetTimer(MathMax(1, InpSeconds));
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason)
{
   EventKillTimer();
}

void OnTimer()
{
   if(InpEndpoint == "") return;

   MqlTick ticks[];
   int copied = CopyTicks(InpSymbol, ticks, COPY_TICKS_ALL, 0, InpMaxTicks);
   if(copied <= 0) return;

   double buyVol = 0.0, sellVol = 0.0;
   double lastBid = 0.0, lastAsk = 0.0;
   long newest = g_last_msc;
   int buyCount = 0, sellCount = 0;

   for(int i=0; i<copied; i++)
   {
      MqlTick t = ticks[i];
      long msc = (long)t.time_msc;
      if(msc <= g_last_msc) continue;
      if(msc > newest) newest = msc;
      if(t.bid > 0) lastBid = t.bid;
      if(t.ask > 0) lastAsk = t.ask;

      double v = t.volume_real > 0 ? t.volume_real : (double)t.volume;
      if(v < 0) v = 0;

      if(IsBuy(t)) { buyVol += v; buyCount++; }
      else if(IsSell(t)) { sellVol += v; sellCount++; }
      else
      {
         // If the broker does not provide trade-side flags, do NOT invent
         // buy/sell volume. Bid/ask-only ticks remain neutral.
      }
   }

   if(newest <= g_last_msc) return;

   double delta = buyVol - sellVol;
   g_cvd += delta;
   double denom = MathMax(MathMin(buyVol, sellVol), 0.0000001);
   double ratio = (MathMax(buyVol, sellVol) / denom);
   double imbalance = 0.0;
   if(buyVol > sellVol && buyVol > 0) imbalance = ratio;
   if(sellVol > buyVol && sellVol > 0) imbalance = -ratio;

   // Conservative absorption proxy: strong opposite-side volume with
   // limited net movement is only calculated when bid/ask are available.
   double mid = (lastBid > 0 && lastAsk > 0) ? (lastBid + lastAsk) / 2.0 : 0.0;
   double spread = (lastBid > 0 && lastAsk > 0) ? (lastAsk - lastBid) : 0.0;
   double absorption = 0.0;
   if(mid > 0 && spread >= 0)
      absorption = (buyVol + sellVol) > 0 ? MathAbs(delta) / (buyVol + sellVol) : 0.0;

   string stamp = TimeToString((datetime)(newest/1000), TIME_DATE|TIME_SECONDS);
   string json = StringFormat(
      "{\"timestamp\":\"%s.%03dZ\",\"symbol\":\"%s\",\"delta\":%.8f,\"cvd\":%.8f,\"buyVolume\":%.8f,\"sellVolume\":%.8f,\"imbalance\":%.8f,\"absorption\":%.8f,\"buyTicks\":%d,\"sellTicks\":%d,\"bid\":%.5f,\"ask\":%.5f,\"source\":\"MT5:%s\",\"isReal\":true}",
      stamp, (int)(newest%1000), JsonEscape(InpSymbol), delta, g_cvd,
      buyVol, sellVol, imbalance, absorption, buyCount, sellCount,
      lastBid, lastAsk, JsonEscape(InpSymbol));

   char post[];
   StringToCharArray(json, post, 0, StringLen(json), CP_UTF8);
   string headers = "Content-Type: application/json\r\n";
   if(InpApiKey != "") headers += "X-OrderFlow-Key: " + InpApiKey + "\r\n";
   char result[];
   string result_headers;
   ResetLastError();
   int code = WebRequest("POST", InpEndpoint, headers, 5000, post, result, result_headers);
   if(code >= 200 && code < 300)
      g_last_msc = newest;
   else
      PrintFormat("Order Flow POST failed: HTTP=%d error=%d", code, GetLastError());
}
