// Current XSMN weekly schedule. Version it when an official schedule changes.
export const XSMN_SCHEDULE_VERSION='2026-11-23';
export const XSMN_WEEKLY_SCHEDULE=Object.freeze({
  0:['tien-giang','kien-giang','da-lat'],
  1:['ho-chi-minh','dong-thap','ca-mau'],
  2:['ben-tre','vung-tau','bac-lieu'],
  3:['dong-nai','can-tho','soc-trang'],
  4:['tay-ninh','an-giang','binh-thuan'],
  5:['vinh-long','binh-duong','tra-vinh'],
  6:['ho-chi-minh','long-an','binh-phuoc','hau-giang']
});
export function stationsForDate(day) {
  if(typeof day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(day))throw new Error('Ngày không hợp lệ');
  const weekday=new Date(`${day}T12:00:00Z`).getUTCDay();
  return [...XSMN_WEEKLY_SCHEDULE[weekday]];
}
