// Exported by opendesigner (opendesigner export): screen "Screen" (route /screen) of document "Test" (doc). DO NOT edit by hand:
// regenerate with `opendesigner export`. The data-node-id attribute ties every element to its design node.
package design.generated.screens

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.dropShadow
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.*
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.shadow.Shadow
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import design.generated.R
import design.generated.components.*

@Composable
fun Screen(onNavigate: (String) -> Unit = {}, onBack: () -> Unit = {}) {
    // Screen (data-node-id="scr")
    Box(
        modifier = Modifier
            .size(400.dp, 300.dp)
            .background(Color(0xFFFFFFFF), RectangleShape)
    ) {
        // Grid (data-node-id="g")
        DesignGrid(
            columns = listOf(GridTrack.Fixed(80.dp), GridTrack.Fr(1f), GridTrack.Hug),
            rows = listOf(GridTrack.Fixed(40.dp)),
            columnGap = 8.dp,
            rowGap = 4.dp,
            horizontalAlignment = Alignment.Start,
            verticalAlignment = Alignment.Top,
            modifier = Modifier
                .size(300.dp, 120.dp)
                .background(Color(0xFFE5E5E5), RectangleShape)
        ) {
            // a (data-node-id="a")
            Box(
                modifier = Modifier
                    .gridCell(0, 0, 1, 1, false, false)
                    .size(20.dp, 20.dp)
                    .background(Color(0xFFFF0000), RectangleShape)
            )
            // b (data-node-id="b")
            Box(
                modifier = Modifier
                    .gridCell(1, 0, 2, 2, false, false)
                    .size(20.dp, 20.dp)
                    .background(Color(0xFF00FF00), RectangleShape)
            )
            // c (data-node-id="c")
            Box(
                modifier = Modifier
                    .gridCell(0, 1, 1, 1, true, false)
                    .height(20.dp)
                    .background(Color(0xFF0000FF), RectangleShape)
            )
        }
    }
}
