import './home.css';
import { addDays, shortDate, taiwanToday } from './arithmetic-model';
declare const __APP_VERSION__: string;
document.getElementById('home-version')!.textContent = __APP_VERSION__;
function refreshQuickDate() {
  const value = addDays(taiwanToday(), 20);
  const date = document.getElementById('arithmetic-quick-date') as HTMLTimeElement;
  date.dateTime = value;
  date.textContent = shortDate(value);
  date.title = value.replaceAll('-', '/');
}
refreshQuickDate();
setInterval(refreshQuickDate, 15_000);
document.addEventListener('visibilitychange', refreshQuickDate);
window.addEventListener('pageshow', refreshQuickDate);
