import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx' // NO CURLY BRACES HERE
import './index.css' // If you have one, otherwise delete this line

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)