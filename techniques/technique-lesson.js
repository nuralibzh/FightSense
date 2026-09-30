// A local file has no HTTP Referer, which YouTube requires for embedded playback.
// Keep the direct YouTube link visible unless the page has an HTTP(S) origin.
if (location.protocol === 'http:' || location.protocol === 'https:') {
    document.querySelectorAll('.lesson-video').forEach((video) => {
        const frame = video.querySelector('iframe[data-src]');
        if (!frame) return;
        frame.src = frame.dataset.src;
        video.classList.add('is-embedded');
    });
}
