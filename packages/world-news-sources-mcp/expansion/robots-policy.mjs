// Bounded discovery policy matching. Network/status decisions are handled by the caller.
const normalize=v=>encodeURI(v).replace(/%25([a-f0-9]{2})/gi,'%$1').replace(/%([a-f0-9]{2})/gi,(m,h)=>/[A-Za-z0-9._~-]/.test(String.fromCharCode(parseInt(h,16)))?String.fromCharCode(parseInt(h,16)):m.toUpperCase());
export function robotsPolicy(text,url){
 const groups=[];let group={agents:[],rules:[]};
 for(const raw of text.split(/\r?\n/)){const m=raw.replace(/#.*$/,'').trim().match(/^([^:]+):\s*(.*)$/);if(!m)continue;const key=m[1].trim().toLowerCase(),value=m[2].trim();if(key==='user-agent'){if(group.rules.length){groups.push(group);group={agents:[],rules:[]};}group.agents.push(value.toLowerCase());}else if(['allow','disallow'].includes(key)&&group.agents.length&&value)group.rules.push({allow:key==='allow',pattern:value});}groups.push(group);
 const specific=groups.filter(g=>g.agents.some(a=>a!=='*'&&a&&'worldnewssourcesmcp'.includes(a))),applicable=specific.length?specific:groups.filter(g=>g.agents.includes('*'));
 const target=normalize(new URL(url).pathname+new URL(url).search);
 const matches=applicable.flatMap(g=>g.rules).filter(r=>{const pattern=normalize(r.pattern),end=pattern.endsWith('$'),body=end?pattern.slice(0,-1):pattern;return new RegExp('^'+body.split('*').map(p=>p.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*')+(end?'$':'')).test(target);}).sort((a,b)=>normalize(b.pattern).replace(/[*$]/g,'').length-normalize(a.pattern).replace(/[*$]/g,'').length||+b.allow-+a.allow);
 return{decision:matches[0]?.allow===false?'disallowed':'allowed',matched_rule:matches[0]??null};
}
