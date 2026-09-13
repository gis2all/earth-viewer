import ReactDOM from 'react-dom/client'
import App from './App'
import { detectBrowserLocale } from './i18n/locale'
import './styles/theme.css'

document.documentElement.lang = detectBrowserLocale()

ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
