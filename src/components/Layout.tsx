import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { useEffect, useRef } from 'react'
import { Icon } from './Icon'

export function Layout() {
  const { pathname } = useLocation()
  const previousPath = useRef(pathname)
  useEffect(() => {
    if (previousPath.current !== pathname) {
      window.scrollTo({ top: 0, behavior: 'instant' })
      document.getElementById('main-content')?.focus({ preventScroll: true })
      previousPath.current = pathname
    }
  }, [pathname])

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        İçeriğe geç
      </a>
      <header className="site-header">
        <div className="page-width header-inner">
          <Link to="/" className="brand" aria-label="Take Two ana sayfa">
            <span className="brand-mark">
              <i />
              <i />
            </span>
            take two<span className="brand-dot">.</span>
          </Link>
          <nav aria-label="Ana menü" className="flex items-center gap-6 sm:gap-9">
            <NavLink to="/" end className="nav-link">
              Sahne arşivi
            </NavLink>
            <NavLink to="/studio" className="nav-link">
              Sahne Stüdyosu
            </NavLink>
            <NavLink to="/join" className="nav-link">
              Odaya katıl
            </NavLink>
            <a href="/#how-it-works" className="nav-link how-link">
              Nasıl oynanır?
            </a>
          </nav>
          <span className="header-badge">
            <span />
            Geliştirme sürümü
          </span>
        </div>
      </header>
      <main id="main-content" tabIndex={-1} className="page-width main-content">
        <Outlet />
      </main>
      <footer className="page-width site-footer">
        <span className="flex items-center gap-2">
          <Icon name="mic" /> Arkadaş grubun için.
        </span>
        <span>Özgün sahneler. Sayısız yorum.</span>
        <span className="footer-version">Take Two · Ön izleme 02</span>
      </footer>
    </div>
  )
}
