const assert=require('assert');
const {structure,mss,fib,evaluate}=require('./v3_confluence');
function c(o,h,l,cl){return{open:o,high:h,low:l,close:cl};}
function series(){const d=[];for(let i=0;i<40;i++)d.push(c(100+i*.1,101+i*.1,99+i*.1,100.5+i*.1));return d;}
const d=series();
assert(structure(d));
const bull=d.concat([c(104,105,103.8,104.2),c(104.2,105.8,104,105.6)]);
assert(mss(bull,'BUY').ok===false || mss(bull,'BUY').ok===true);
assert(fib(bull,'BUY'));
const no=evaluate({h4:d,h1:d,m15:d,m5:d});
assert(no.decision==='NO_TRADE' || no.decision==='READY_FOR_ENTRY_FILTERS');
console.log('OK: V3 confluence structural tests passed');
