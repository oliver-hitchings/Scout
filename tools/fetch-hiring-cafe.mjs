import { fetchHiringCafe } from '../ui/lib/hiringCafe.mjs';

const result = await fetchHiringCafe();
console.log(JSON.stringify(result, null, 2));
