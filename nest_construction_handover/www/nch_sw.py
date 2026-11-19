"""/nch_sw.js: the service worker that lets a field phone open Com-Struct with no signal.

Served from the site root so it may look after every desk page. Rendered raw (no
website layout around it) and never page-cached, so a new version reaches phones
on the next visit.
"""

no_cache = True


def get_context(context):
	context.base_template = None
