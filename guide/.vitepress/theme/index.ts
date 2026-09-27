import DefaultTheme from 'vitepress/theme'
import GuideFigure from './GuideFigure.vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('GuideFigure', GuideFigure)
  }
}
