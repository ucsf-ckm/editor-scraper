const { ipcRenderer } = require('electron')

window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('get-editors').addEventListener('click', () => {
    const publisher = document.getElementById('publisher').value
    if (publisher) {
      document.getElementById('progress').innerHTML = '<progress></progress>'
      ipcRenderer.send('get-editors', publisher)
    }
    return false
  })

  ipcRenderer.on('print', (event, arg) => {
    document.getElementById('results').innerText += arg
  })

  ipcRenderer.on('done', (event, arg) => {
    document.getElementById('progress').innerHTML = ''
  })
})
