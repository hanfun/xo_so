// Current XSMN weekly schedule. Version it when an official schedule changes.
export const XSMN_SCHEDULE_VERSION='2026-11-23';
export const XSMN_STATION_NAMES=Object.freeze({
  'tien-giang':'Tiền Giang',
  'kien-giang':'Kiên Giang',
  'da-lat':'Đà Lạt',
  'ho-chi-minh':'TP. Hồ Chí Minh',
  'dong-thap':'Đồng Tháp',
  'ca-mau':'Cà Mau',
  'ben-tre':'Bến Tre',
  'vung-tau':'Vũng Tàu',
  'bac-lieu':'Bạc Liêu',
  'dong-nai':'Đồng Nai',
  'can-tho':'Cần Thơ',
  'soc-trang':'Sóc Trăng',
  'tay-ninh':'Tây Ninh',
  'an-giang':'An Giang',
  'binh-thuan':'Bình Thuận',
  'vinh-long':'Vĩnh Long',
  'binh-duong':'Bình Dương',
  'tra-vinh':'Trà Vinh',
  'long-an':'Long An',
  'binh-phuoc':'Bình Phước',
  'hau-giang':'Hậu Giang'
});
export const XSMN_WEEKLY_SCHEDULE=Object.freeze({
  0:['tien-giang','kien-giang','da-lat'],
  1:['ho-chi-minh','dong-thap','ca-mau'],
  2:['ben-tre','vung-tau','bac-lieu'],
  3:['dong-nai','can-tho','soc-trang'],
  4:['tay-ninh','an-giang','binh-thuan'],
  5:['vinh-long','binh-duong','tra-vinh'],
  6:['ho-chi-minh','long-an','binh-phuoc','hau-giang']
});
export function stationDisplayName(code) {
  return XSMN_STATION_NAMES[code] || code;
}
export function stationsForDate(day) {
  if(typeof day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(day))throw new Error('Ngày không hợp lệ');
  const weekday=new Date(`${day}T12:00:00Z`).getUTCDay();
  return [...XSMN_WEEKLY_SCHEDULE[weekday]];
}
export function stationDetailsForDate(day) {
  return stationsForDate(day).map(code=>({code,name:stationDisplayName(code)}));
}
