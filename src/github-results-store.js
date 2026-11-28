// One versioned JSON dataset; a compare-and-swap write prevents lost updates across dates.
const defaultRepo = 'hanfun/xo_so';
const defaultPath = 'data/results.json';
function encode(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let start=0;start<bytes.length;start+=16384) {
    binary += String.fromCharCode(...bytes.subarray(start,start+16384));
  }
  return btoa(binary);
}
function decode(value) {
  const bytes = Uint8Array.from(atob(value.replace(/\s/g,'')),c=>c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
export function validateDataset(days) {
  if (!days || typeof days !== 'object' || Array.isArray(days)) throw Error('Invalid results dataset');
  for (const [day,report] of Object.entries(days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || report?.date!==day || !Array.isArray(report.results))
      throw Error('Invalid report in results dataset: '+day);
  }
  return days;
}
export function githubResultsStore(token,{fetchImpl=fetch,repo=defaultRepo,path=defaultPath,branch='main'}={}) {
  if (!token) throw Error('Missing GITHUB_TOKEN');
  const base = 'https://api.github.com/repos/'+repo;
  const url = base+'/contents/'+path;
  const headers = {Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
    'X-GitHub-Api-Version':'2022-11-28','User-Agent':'xo-so-sync-worker'};
  let snapshot;
  return {
    async read(day) {
      const res=await fetchImpl(url+'?ref='+encodeURIComponent(branch),{headers,cache:'no-store'});
      // Never recreate the entire dataset from a missing or inaccessible file.
      if (!res.ok) throw Error('GitHub dataset read HTTP '+res.status);
      const file=await res.json();
      if (!/^[0-9a-f]{40}$/.test(file.sha??'')) throw Error('Invalid GitHub dataset SHA');
      let source;
      if (file.encoding==='base64' && typeof file.content==='string' && file.content.length) {
        source=decode(file.content);
      } else {
        // Contents API omits content above 1 MB. Read the immutable blob by SHA.
        const blob=await fetchImpl(base+'/git/blobs/'+file.sha,{headers:{...headers,Accept:'application/vnd.github.raw+json'},cache:'no-store'});
        if (!blob.ok) throw Error('GitHub dataset blob HTTP '+blob.status);
        source=await blob.text();
      }
      const days=validateDataset(JSON.parse(source));
      snapshot={sha:file.sha,days};
      return {report:days[day]??null,sha:file.sha};
    },
    async write(day,report,sha) {
      if (!snapshot || snapshot.sha!==sha || !sha) throw Error('Dataset must be read before writing');
      if (report?.date!==day || !Array.isArray(report.results) || report.results.length===0)
        throw Error('Refusing empty or mismatched report');
      const days={...snapshot.days,[day]:report};
      const sorted=Object.fromEntries(Object.entries(days).sort(([a],[b])=>a.localeCompare(b)));
      const res=await fetchImpl(url,{method:'PUT',headers:{...headers,'Content-Type':'application/json'},
        body:JSON.stringify({message:'data: cập nhật XSMN '+day,branch,sha,
          content:encode(JSON.stringify(sorted)+'\n')})});
      // syncDate rereads the full latest snapshot, merges again and retries on conflict.
      if ([409,422].includes(res.status)) return false;
      if (!res.ok) throw Error('GitHub dataset write HTTP '+res.status);
      return true;
    }
  };
}
