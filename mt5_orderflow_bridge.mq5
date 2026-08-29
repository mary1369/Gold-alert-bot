#property strict
#property version "1.0"

input string EndpointURL = "https://YOUR-BRIDGE-HOST/mt5/orderflow";
input string BridgeSecret = "";
input int WindowSeconds = 60;
input int TimerSeconds = 5;

string JsonEscape(string s){ StringReplace(s,"\\","\\\\"); StringReplace(s,"\"","\\\""); return s; }

double TickVolume(const MqlTick &t){
   if(t.volume_real>0.0) return t.volume_real;
   if(t.volume>0) return (double)t.volume;
   return 1.0;
}

bool BuildFlow(double &delta,double &prevDelta,double &cvdSlope,long &tickCount,string &imbalance,string &absorption){
   ulong now=(ulong)TimeCurrent()*1000;
   ulong from=(now-(ulong)WindowSeconds*1000);
   ulong prevFrom=(now-(ulong)(WindowSeconds*2)*1000);
   MqlTick ticks[];
   int n=CopyTicksRange(_Symbol,ticks,COPY_TICKS_ALL,from,now);
   if(n<=0) return false;
   delta=0; prevDelta=0; tickCount=0;
   double buyVol=0,sellVol=0;
   for(int i=0;i<n;i++){
      double v=TickVolume(ticks[i]);
      bool buy=((ticks[i].flags&TICK_FLAG_BUY)==TICK_FLAG_BUY);
      bool sell=((ticks[i].flags&TICK_FLAG_SELL)==TICK_FLAG_SELL);
      if(buy&&!sell){ delta+=v; buyVol+=v; tickCount++; }
      else if(sell&&!buy){ delta-=v; sellVol+=v; tickCount++; }
   }
   MqlTick prev[];
   int pn=CopyTicksRange(_Symbol,prev,COPY_TICKS_ALL,prevFrom,from-1);
   if(pn>0){
      for(int i=0;i<pn;i++){
         double v=TickVolume(prev[i]);
         bool buy=((prev[i].flags&TICK_FLAG_BUY)==TICK_FLAG_BUY);
         bool sell=((prev[i].flags&TICK_FLAG_SELL)==TICK_FLAG_SELL);
         if(buy&&!sell) prevDelta+=v;
         else if(sell&&!buy) prevDelta-=v;
      }
   }
   cvdSlope=delta-prevDelta;
   double total=buyVol+sellVol;
   if(total<=0) imbalance="NEUTRAL";
   else if(buyVol/total>=0.65) imbalance="BUY_IMBALANCE";
   else if(sellVol/total>=0.65) imbalance="SELL_IMBALANCE";
   else imbalance="NEUTRAL";
   absorption="NONE";
   return tickCount>=5;
}

void SendFlow(){
   if(StringLen(EndpointURL)<20 || StringLen(BridgeSecret)<16) return;
   double delta,prevDelta,cvdSlope; long ticks; string imbalance,absorption;
   if(!BuildFlow(delta,prevDelta,cvdSlope,ticks,imbalance,absorption)) return;
   string iso=TimeToString(TimeGMT(),TIME_DATE|TIME_SECONDS);
   StringReplace(iso,".","-"); StringReplace(iso," ","T"); iso+="Z";
   string body=StringFormat("{\"source\":\"MT5\",\"symbol\":\"%s\",\"time\":\"%s\",\"delta\":%.8f,\"cvdSlope\":%.8f,\"imbalance\":\"%s\",\"absorption\":\"%s\",\"tickCount\":%I64d}",_Symbol,JsonEscape(iso),delta,cvdSlope,imbalance,absorption,ticks);
   string headers="Content-Type: application/json\r\nAuthorization: Bearer "+BridgeSecret+"\r\n";
   char data[],result[]; string responseHeaders;
   StringToCharArray(body,data,0,StringLen(body),CP_UTF8);
   ResetLastError();
   int code=WebRequest("POST",EndpointURL,headers,5000,data,result,responseHeaders);
   if(code<200 || code>=300) PrintFormat("Order Flow bridge HTTP=%d err=%d",code,GetLastError());
}

int OnInit(){ EventSetTimer(MathMax(1,TimerSeconds)); return INIT_SUCCEEDED; }
void OnDeinit(const int reason){ EventKillTimer(); }
void OnTimer(){ SendFlow(); }
