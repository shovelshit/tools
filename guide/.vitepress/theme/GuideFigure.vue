<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from 'vue'

defineProps<{
  src: string
  alt: string
  caption: string
  crop?: 'top' | 'center' | 'bottom'
  highlight?: { left: number; top: number; width: number; height: number; number: number }
}>()

const open = ref(false)
const trigger = ref<HTMLButtonElement | null>(null)
const closeButton = ref<HTMLButtonElement | null>(null)
let previousOverflow = ''

async function show() {
  previousOverflow = document.documentElement.style.overflow
  document.documentElement.style.overflow = 'hidden'
  open.value = true
  document.addEventListener('keydown', onKeydown)
  await nextTick()
  closeButton.value?.focus()
}

function hide() {
  if (!open.value) return
  open.value = false
  document.removeEventListener('keydown', onKeydown)
  document.documentElement.style.overflow = previousOverflow
  trigger.value?.focus()
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    hide()
  } else if (event.key === 'Tab') {
    event.preventDefault()
    closeButton.value?.focus()
  }
}

onBeforeUnmount(() => {
  if (open.value) document.documentElement.style.overflow = previousOverflow
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <figure class="guide-figure">
    <button ref="trigger" type="button" class="guide-figure-trigger" :class="crop && ['is-cropped', `crop-${crop}`]" :aria-label="`查看大图：${alt}`" @click="show">
      <span class="guide-figure-image">
        <img :src="src" :alt="alt" loading="lazy" />
        <span
          v-if="highlight"
          class="guide-figure-highlight"
          :style="{
            left: `${highlight.left}%`, top: `${highlight.top}%`,
            width: `${highlight.width}%`, height: `${highlight.height}%`
          }"
          aria-hidden="true"
        ><span class="guide-figure-highlight-number">{{ highlight.number }}</span></span>
      </span>
    </button>
    <figcaption>{{ caption }}</figcaption>
  </figure>
  <Teleport to="body">
    <div v-if="open" class="guide-lightbox" role="presentation" @click.self="hide">
      <div class="guide-lightbox-dialog" role="dialog" aria-modal="true" :aria-label="caption">
        <button ref="closeButton" type="button" class="guide-lightbox-close" aria-label="关闭大图" @click="hide">×</button>
        <img :src="src" :alt="alt" />
        <p>{{ caption }}</p>
      </div>
    </div>
  </Teleport>
</template>
